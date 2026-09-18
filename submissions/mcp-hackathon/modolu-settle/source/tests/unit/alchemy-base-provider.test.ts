import { HttpRequestError, TimeoutError } from "viem";
import { describe, expect, it } from "vitest";

import { createAlchemyBaseProvider, redactProviderError, type BaseRpcClient } from "@/integrations/chain/alchemy-base-provider";
import { AppError } from "@/lib/errors";

const SECRET_URL = "https://base-mainnet.g.alchemy.com/v2/super-secret-api-key";

const unused = async (): Promise<never> => {
  throw new Error("not expected in this test");
};

function clientReturning(value: unknown): BaseRpcClient {
  return { getBlockNumber: async () => value as bigint, getLogs: unused, getBlock: unused };
}

function clientThrowing(error: unknown): BaseRpcClient {
  return {
    getBlockNumber: async () => {
      throw error;
    },
    getLogs: unused,
    getBlock: unused,
  };
}

async function captureAppError(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    return error as AppError;
  }
  return expect.unreachable("expected an AppError");
}

describe("createAlchemyBaseProvider", () => {
  it("returns the latest block as bigint", async () => {
    const provider = createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client: clientReturning(35_123_456n) });
    await expect(provider.getLatestBlock()).resolves.toBe(35_123_456n);
  });

  it("maps HTTP failures to a retryable UPSTREAM_UNAVAILABLE without leaking the URL", async () => {
    const viemError = new HttpRequestError({
      url: SECRET_URL,
      status: 429,
      body: { method: "eth_blockNumber" },
      details: "Too Many Requests",
    });
    expect(viemError.message).toContain("super-secret-api-key"); // viem does include it
    const provider = createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client: clientThrowing(viemError) });

    const error = await captureAppError(provider.getLatestBlock());
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.httpStatus).toBe(503);
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("Blockchain provider is temporarily unavailable");
    expect(error.cause).toBeUndefined();
    expect(error.context).toEqual({
      provider: "alchemy",
      operation: "getBlockNumber",
      providerError: { name: "HttpRequestError", shortMessage: "HTTP request failed.", status: 429 },
    });
    expect(JSON.stringify({ message: error.message, context: error.context, stack: error.stack })).not.toContain(
      "super-secret",
    );
  });

  it("maps timeouts and non-viem errors to UPSTREAM_UNAVAILABLE", async () => {
    const timeout = new TimeoutError({ body: { method: "eth_blockNumber" }, url: SECRET_URL });
    const fromTimeout = await captureAppError(
      createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client: clientThrowing(timeout) }).getLatestBlock(),
    );
    expect(fromTimeout.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(fromTimeout.context)).not.toContain("super-secret");

    const fromSocket = await captureAppError(
      createAlchemyBaseProvider({
        rpcUrl: SECRET_URL,
        client: clientThrowing(new Error(`connect ECONNREFUSED ${SECRET_URL}`)),
      }).getLatestBlock(),
    );
    expect(fromSocket.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(fromSocket.context).toEqual({
      provider: "alchemy",
      operation: "getBlockNumber",
      providerError: { name: "Error", shortMessage: "Non-RPC error" },
    });
  });

  it.each([undefined, null, "0x1", 12, -1n])("maps an invalid block number %s to UPSTREAM_INVALID_RESPONSE", async (value) => {
    const error = await captureAppError(
      createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client: clientReturning(value) }).getLatestBlock(),
    );
    expect(error.code).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(error.httpStatus).toBe(502);
    expect(error.retryable).toBe(false);
  });

  it("redacts unknown thrown values", () => {
    expect(redactProviderError("boom")).toEqual({ name: "UnknownError", shortMessage: "Non-error value thrown" });
  });
});

// ---------------------------------------------------------------------------
// Milestone 2: transfer log queries and block timestamps
// ---------------------------------------------------------------------------
import { InvalidParamsRpcError, LimitExceededRpcError, RpcRequestError } from "viem";

import { USDC_CONTRACT_ADDRESS } from "@/integrations/chain/base-usdc";

const PAYER = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const RECIPIENT = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TX = `0x${"c".repeat(64)}`;
const BLOCK_HASH = `0x${"d".repeat(64)}`;

function validLog(overrides: Record<string, unknown> = {}) {
  return {
    address: USDC_CONTRACT_ADDRESS,
    args: { from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: 25_000_000n },
    blockNumber: 1_050n,
    blockHash: BLOCK_HASH,
    transactionHash: TX,
    logIndex: 42,
    removed: false,
    ...overrides,
  };
}

function logsClient(impl: (params: unknown) => Promise<unknown>) {
  const calls: unknown[] = [];
  const client: BaseRpcClient = {
    getBlockNumber: unused,
    getBlock: unused,
    getLogs: (async (params: unknown) => {
      calls.push(params);
      return impl(params);
    }) as unknown as BaseRpcClient["getLogs"],
  };
  return { client, calls };
}

const query = { fromBlock: 1_000n, toBlock: 1_100n, recipient: RECIPIENT, payer: PAYER };
const recipientOnly = { ...query, payer: null };

describe("createAlchemyBaseProvider.getUsdcTransfers", () => {
  it("queries eth_getLogs for the native USDC Transfer event filtered by payer, recipient and block range", async () => {
    const { client, calls } = logsClient(async () => [validLog()]);
    const provider = createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client });

    const transfers = await provider.getUsdcTransfers(query);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      event: { type: "event", name: "Transfer" },
      args: { from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      fromBlock: 1_000n,
      toBlock: 1_100n,
      strict: true,
    });
    expect(transfers).toEqual([
      { txHash: TX, logIndex: 42, blockNumber: 1_050n, blockHash: BLOCK_HASH, from: PAYER, to: RECIPIENT, amountUnits: 25_000_000n },
    ]);
  });

  it("without a payer filters only by recipient at the RPC level and accepts any sender", async () => {
    const { client, calls } = logsClient(async () => [
      validLog(),
      validLog({ args: { from: "0x1111111111111111111111111111111111111111", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: 5n }, logIndex: 43 }),
    ]);
    const transfers = await createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers(recipientOnly);
    expect(calls[0]).toMatchObject({ args: { to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" }, fromBlock: 1_000n, toBlock: 1_100n, strict: true });
    expect((calls[0] as { args: Record<string, unknown> }).args).not.toHaveProperty("from");
    expect(transfers.map((t) => [t.from, t.amountUnits])).toEqual([
      [PAYER, 25_000_000n],
      ["0x1111111111111111111111111111111111111111", 5n],
    ]);
  });

  it("without a payer still rejects a log whose recipient differs or whose sender is malformed", async () => {
    const wrongTo = logsClient(async () => [validLog({ args: { from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", to: "0x1111111111111111111111111111111111111111", value: 1n } })]);
    expect((await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client: wrongTo.client }).getUsdcTransfers(recipientOnly))).code).toBe("UPSTREAM_INVALID_RESPONSE");
    const badFrom = logsClient(async () => [validLog({ args: { from: "0xnope", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: 1n } })]);
    expect((await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client: badFrom.client }).getUsdcTransfers(recipientOnly))).code).toBe("UPSTREAM_INVALID_RESPONSE");
  });

  it("returns an empty array for no logs", async () => {
    const { client } = logsClient(async () => []);
    await expect(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers(query)).resolves.toEqual([]);
  });

  it.each([
    ["wrong contract", { address: "0x1111111111111111111111111111111111111111" }],
    ["wrong sender", { args: { from: "0x1111111111111111111111111111111111111111", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: 1n } }],
    ["wrong recipient", { args: { from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", to: "0x1111111111111111111111111111111111111111", value: 1n } }],
    ["negative value", { args: { from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: -1n } }],
    ["number value", { args: { from: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045", to: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", value: 1 } }],
    ["block out of range", { blockNumber: 1_101n }],
    ["pending block", { blockNumber: null }],
    ["removed log", { removed: true }],
    ["bad block hash", { blockHash: "0x1234" }],
    ["bad tx hash", { transactionHash: "0x1234" }],
    ["bad log index", { logIndex: -1 }],
  ])("rejects a log with %s as UPSTREAM_INVALID_RESPONSE", async (_label, overrides) => {
    const { client } = logsClient(async () => [validLog(overrides)]);
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers(query));
    expect(error.code).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(error.retryable).toBe(false);
  });

  it("treats a log-query failure as a retryable upstream error, never as zero transfers", async () => {
    const { client } = logsClient(async () => {
      throw new HttpRequestError({ url: SECRET_URL, status: 503, body: { method: "eth_getLogs" } });
    });
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers(query));
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.context).toMatchObject({ operation: "getLogs" });
    expect(JSON.stringify({ message: error.message, context: error.context })).not.toContain("super-secret");
  });

  it.each([
    ["LimitExceededRpcError", (cause: RpcRequestError) => new LimitExceededRpcError(cause), -32005],
    ["InvalidParamsRpcError", (cause: RpcRequestError) => new InvalidParamsRpcError(cause), -32602],
  ])("maps an explicit %s (range/response limit) to a non-retryable UPSTREAM_UNAVAILABLE without truncating", async (_name, build, code) => {
    const cause = new RpcRequestError({
      body: { method: "eth_getLogs" },
      error: { code, message: `Log response size exceeded. ${SECRET_URL}` },
      url: SECRET_URL,
    });
    const { client, calls } = logsClient(async () => {
      throw build(cause);
    });
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers(query));
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.retryable).toBe(false);
    expect(error.message).toBe("Blockchain provider could not serve the requested block range");
    expect(error.context).toMatchObject({ providerError: { rpcCode: code } });
    expect(JSON.stringify(error.context)).not.toContain("super-secret");
    expect(calls).toHaveLength(1); // no retry, no chunking
  });

  it("refuses an inverted block range before calling the provider", async () => {
    const { client, calls } = logsClient(async () => []);
    await expect(
      createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers({ ...query, fromBlock: 1_101n }),
    ).rejects.toThrow(/invalid block range/);
    expect(calls).toHaveLength(0);
  });
});

describe("createAlchemyBaseProvider.getBlockTimestamp", () => {
  function blockClient(impl: (params: unknown) => Promise<unknown>): BaseRpcClient {
    return { getBlockNumber: unused, getLogs: unused, getBlock: impl as unknown as BaseRpcClient["getBlock"] };
  }

  it("returns the block timestamp as a Date from the bigint seconds value", async () => {
    const client = blockClient(async (params) => {
      expect(params).toEqual({ blockNumber: 1_050n, includeTransactions: false });
      return { number: 1_050n, timestamp: 1_789_685_400n, hash: BLOCK_HASH };
    });
    await expect(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getBlockTimestamp(1_050n)).resolves.toEqual(
      new Date("2026-09-17T22:50:00.000Z"),
    );
  });

  it.each([
    ["mismatched number", { number: 1_051n, timestamp: 1_789_685_400n }],
    ["missing timestamp", { number: 1_050n }],
    ["number timestamp", { number: 1_050n, timestamp: 1_789_685_400 }],
    ["zero timestamp", { number: 1_050n, timestamp: 0n }],
    ["null block", null],
  ])("rejects %s as UPSTREAM_INVALID_RESPONSE", async (_label, block) => {
    const client = blockClient(async () => block);
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getBlockTimestamp(1_050n));
    expect(error.code).toBe("UPSTREAM_INVALID_RESPONSE");
  });

  it("maps a block fetch failure to a retryable upstream error", async () => {
    const client = blockClient(async () => {
      throw new TimeoutError({ body: { method: "eth_getBlockByNumber" }, url: SECRET_URL });
    });
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getBlockTimestamp(1_050n));
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(error.context).toMatchObject({ operation: "getBlock" });
  });
});

describe("createAlchemyBaseProvider.findLastBlockAtOrBefore", () => {
  it("searches through getBlock reads and returns the boundary block", async () => {
    const reads: bigint[] = [];
    const client: BaseRpcClient = {
      getBlockNumber: unused,
      getLogs: unused,
      getBlock: (async (params: { blockNumber: bigint }) => {
        reads.push(params.blockNumber);
        return { number: params.blockNumber, timestamp: params.blockNumber * 2n, hash: BLOCK_HASH };
      }) as unknown as BaseRpcClient["getBlock"],
    };
    const provider = createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client });
    await expect(provider.findLastBlockAtOrBefore(new Date(500 * 2_000 + 1_000), { fromBlock: 1n, toBlock: 1_000n })).resolves.toBe(500n);
    expect(reads.length).toBeLessThanOrEqual(12);
    await expect(provider.findLastBlockAtOrBefore(new Date(0), { fromBlock: 1n, toBlock: 1_000n })).resolves.toBeNull();
  });

  it("propagates a block-read failure as a retryable upstream error", async () => {
    const client: BaseRpcClient = {
      getBlockNumber: unused,
      getLogs: unused,
      getBlock: (async () => {
        throw new TimeoutError({ body: { method: "eth_getBlockByNumber" }, url: SECRET_URL });
      }) as unknown as BaseRpcClient["getBlock"],
    };
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).findLastBlockAtOrBefore(new Date(), { fromBlock: 1n, toBlock: 10n }));
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(JSON.stringify(error.context)).not.toContain("super-secret");
  });
});

// ---------------------------------------------------------------------------
// Milestone 5: failure classification matrix and redaction across every path
// ---------------------------------------------------------------------------
import { InternalRpcError, RpcRequestError as RpcRequestErrorM5 } from "viem";

describe("provider failure matrix (every path: stable code, safe message, no credential)", () => {
  const rpcError = (code: number, message: string) =>
    new RpcRequestErrorM5({ body: { method: "eth_getLogs" }, error: { code, message: `${message} ${SECRET_URL}` }, url: SECRET_URL });

  const cases: Array<[string, () => Error, "UPSTREAM_UNAVAILABLE" | "UPSTREAM_INVALID_RESPONSE", boolean]> = [
    ["timeout", () => new TimeoutError({ body: { method: "eth_getLogs" }, url: SECRET_URL }), "UPSTREAM_UNAVAILABLE", true],
    ["connection failure (fetch failed)", () => new TypeError(`fetch failed: connect ECONNREFUSED ${SECRET_URL}`), "UPSTREAM_UNAVAILABLE", true],
    ["HTTP provider failure (503)", () => new HttpRequestError({ url: SECRET_URL, status: 503, body: { method: "eth_getLogs" }, details: "Service Unavailable" }), "UPSTREAM_UNAVAILABLE", true],
    ["HTTP provider failure (401 bad key)", () => new HttpRequestError({ url: SECRET_URL, status: 401, body: { method: "eth_getLogs" }, details: "Must be authenticated!" }), "UPSTREAM_UNAVAILABLE", true],
    ["JSON-RPC internal error (-32603)", () => new InternalRpcError(rpcError(-32603, "internal error")), "UPSTREAM_UNAVAILABLE", true],
    ["generic JSON-RPC request error", () => rpcError(-32000, "execution reverted"), "UPSTREAM_UNAVAILABLE", true],
    ["eth_getLogs range/size failure (-32005)", () => new LimitExceededRpcError(rpcError(-32005, "query returned more than 10000 results")), "UPSTREAM_UNAVAILABLE", false],
    ["eth_getLogs invalid params (-32602)", () => new InvalidParamsRpcError(rpcError(-32602, "block range too large")), "UPSTREAM_UNAVAILABLE", false],
  ];

  for (const [label, make, code, retryable] of cases) {
    it(`getUsdcTransfers: ${label} → ${code} (retryable=${retryable})`, async () => {
      const { client } = logsClient(async () => {
        throw make();
      });
      const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers(query));
      expect(error.code).toBe(code);
      expect(error.retryable).toBe(retryable);
      expect(error.message).toMatch(/^Blockchain provider (is temporarily unavailable|could not serve the requested block range)$/);
      const serialized = JSON.stringify({ message: error.message, context: error.context, cause: error.cause ?? null, stack: error.stack });
      expect(serialized).not.toContain("super-secret");
      expect(serialized).not.toContain("execution reverted");
      expect(serialized).not.toContain("Must be authenticated");
    });
  }

  it("block lookup failure → UPSTREAM_UNAVAILABLE without leaking the URL", async () => {
    const client: BaseRpcClient = {
      getBlockNumber: unused,
      getLogs: unused,
      getBlock: (async () => {
        throw new HttpRequestError({ url: SECRET_URL, status: 502, body: { method: "eth_getBlockByNumber" } });
      }) as unknown as BaseRpcClient["getBlock"],
    };
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getBlockTimestamp(1n));
    expect(error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(error.retryable).toBe(true);
    expect(JSON.stringify({ c: error.context, m: error.message })).not.toContain("super-secret");
  });

  it("malformed provider response (non-array logs) → UPSTREAM_INVALID_RESPONSE, not retryable", async () => {
    const { client } = logsClient(async () => ({ not: "an array" }));
    const error = await captureAppError(createAlchemyBaseProvider({ rpcUrl: SECRET_URL, client }).getUsdcTransfers(query));
    expect(error.code).toBe("UPSTREAM_INVALID_RESPONSE");
    expect(error.retryable).toBe(false);
  });

  it("uses a finite HTTP timeout and no automatic retries for the real transport", () => {
    // The transport options are private to viem; assert the documented defaults on our side.
    expect(typeof createAlchemyBaseProvider).toBe("function");
    const source = createAlchemyBaseProvider.toString();
    expect(source).toContain("retryCount: 0");
    expect(source).toMatch(/timeout: options\.timeoutMs \?\? DEFAULT_TIMEOUT_MS/);
  });
});
