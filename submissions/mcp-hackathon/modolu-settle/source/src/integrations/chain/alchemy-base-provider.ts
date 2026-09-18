/**
 * `ChainProvider` implementation backed by an Alchemy Base mainnet JSON-RPC
 * endpoint through viem. This is the only module that creates a viem RPC
 * client or knows the transport URL (ARCHITECTURE.md §6).
 *
 * The RPC URL embeds the provider credential. viem error messages can contain
 * that URL, so provider errors are never re-thrown or attached as `cause`;
 * only a redacted summary reaches the application error.
 */
import "server-only";

import {
  BaseError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  createPublicClient,
  getAddress,
  http,
  isAddress,
  type PublicClient,
} from "viem";

import { AppError } from "@/lib/errors";
import type { BlockRange, ChainProvider, ChainTransfer, UsdcTransferQuery } from "@/ports/chain-provider";

import { BASE_CHAIN, ERC20_TRANSFER_EVENT_ABI, USDC_CONTRACT_ADDRESS } from "./base-usdc";
import { findLastBlockAtOrBefore } from "./block-search";

/** The subset of a viem public client the provider uses; injectable for tests. */
export type BaseRpcClient = Pick<PublicClient, "getBlockNumber" | "getLogs" | "getBlock">;

export interface AlchemyBaseProviderOptions {
  readonly rpcUrl: string;
  /** Per-request timeout; defaults to 10 seconds. */
  readonly timeoutMs?: number;
  /** Test seam; when omitted a viem HTTP client is created from `rpcUrl`. */
  readonly client?: BaseRpcClient;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const TRANSFER_EVENT = ERC20_TRANSFER_EVENT_ABI[0];
const USDC_CONTRACT_LOWERCASE = USDC_CONTRACT_ADDRESS.toLowerCase();
const HASH_32 = /^0x[0-9a-f]{64}$/;

/** Summary of a provider failure that is safe to log: never includes the URL or payloads. */
export interface RedactedProviderError {
  readonly name: string;
  readonly shortMessage: string;
  readonly status?: number;
  readonly rpcCode?: number;
}

export function redactProviderError(error: unknown): RedactedProviderError {
  if (error instanceof BaseError) {
    const summary: { name: string; shortMessage: string; status?: number; rpcCode?: number } = {
      name: error.name,
      shortMessage: error.shortMessage,
    };
    if ("status" in error && typeof error.status === "number") {
      summary.status = error.status;
    }
    if ("code" in error && typeof error.code === "number") {
      summary.rpcCode = error.code;
    }
    return summary;
  }
  if (error instanceof Error) {
    return { name: error.name, shortMessage: "Non-RPC error" };
  }
  return { name: "UnknownError", shortMessage: "Non-error value thrown" };
}

/**
 * Maps a thrown provider error to the stable upstream error. Explicit
 * range/response-size rejections (Alchemy answers those with -32602 or
 * -32005) are still `UPSTREAM_UNAVAILABLE` but flagged non-retryable, since
 * repeating the same query cannot succeed; nothing is ever truncated to fit.
 */
function toUpstreamError(operation: string, error: unknown): AppError {
  const providerError = redactProviderError(error);
  const isQueryLimit = error instanceof LimitExceededRpcError || error instanceof InvalidParamsRpcError;
  return new AppError(
    "UPSTREAM_UNAVAILABLE",
    isQueryLimit
      ? "Blockchain provider could not serve the requested block range"
      : "Blockchain provider is temporarily unavailable",
    {
      retryable: !isQueryLimit,
      context: { provider: "alchemy", operation, providerError },
    },
  );
}

function invalidResponse(operation: string, reason: string): AppError {
  return new AppError("UPSTREAM_INVALID_RESPONSE", "Blockchain provider returned an invalid response", {
    context: { provider: "alchemy", operation, reason },
  });
}

/**
 * Converts one decoded viem log into a `ChainTransfer`, verifying every field
 * the reconciliation engine relies on. The RPC filter already constrains
 * contract, `from` and `to`; this re-checks them so a misbehaving node can
 * never inject evidence.
 */
function toChainTransfer(log: unknown, query: UsdcTransferQuery): ChainTransfer {
  if (typeof log !== "object" || log === null) {
    throw invalidResponse("getLogs", "log is not an object");
  }
  const candidate = log as {
    address?: unknown;
    args?: unknown;
    blockNumber?: unknown;
    blockHash?: unknown;
    transactionHash?: unknown;
    logIndex?: unknown;
    removed?: unknown;
  };
  if (typeof candidate.address !== "string" || candidate.address.toLowerCase() !== USDC_CONTRACT_LOWERCASE) {
    throw invalidResponse("getLogs", "log emitted by an unexpected contract");
  }
  if (candidate.removed === true) {
    throw invalidResponse("getLogs", "log marked removed");
  }
  const args = (candidate.args ?? {}) as { from?: unknown; to?: unknown; value?: unknown };
  if (typeof args.from !== "string" || !isAddress(args.from)) {
    throw invalidResponse("getLogs", "log sender malformed");
  }
  if (query.payer !== null && args.from.toLowerCase() !== query.payer) {
    throw invalidResponse("getLogs", "log sender does not match the payer filter");
  }
  if (typeof args.to !== "string" || !isAddress(args.to) || args.to.toLowerCase() !== query.recipient) {
    throw invalidResponse("getLogs", "log recipient does not match the recipient filter");
  }
  if (typeof args.value !== "bigint" || args.value < 0n) {
    throw invalidResponse("getLogs", "log value is not a non-negative integer");
  }
  if (typeof candidate.blockNumber !== "bigint" || candidate.blockNumber < query.fromBlock || candidate.blockNumber > query.toBlock) {
    throw invalidResponse("getLogs", "log block number outside the requested range");
  }
  if (typeof candidate.blockHash !== "string" || !HASH_32.test(candidate.blockHash.toLowerCase())) {
    throw invalidResponse("getLogs", "log block hash malformed");
  }
  if (typeof candidate.transactionHash !== "string" || !HASH_32.test(candidate.transactionHash.toLowerCase())) {
    throw invalidResponse("getLogs", "log transaction hash malformed");
  }
  if (typeof candidate.logIndex !== "number" || !Number.isInteger(candidate.logIndex) || candidate.logIndex < 0) {
    throw invalidResponse("getLogs", "log index malformed");
  }
  return {
    txHash: candidate.transactionHash.toLowerCase(),
    logIndex: candidate.logIndex,
    blockNumber: candidate.blockNumber,
    blockHash: candidate.blockHash.toLowerCase(),
    from: args.from.toLowerCase(),
    to: args.to.toLowerCase(),
    amountUnits: args.value,
  };
}

export function createAlchemyBaseProvider(options: AlchemyBaseProviderOptions): ChainProvider {
  const client: BaseRpcClient =
    options.client ??
    createPublicClient({
      chain: BASE_CHAIN,
      transport: http(options.rpcUrl, {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        retryCount: 0,
      }),
      // The latest block fixes an intent's matching boundary; never serve a cached value.
      cacheTime: 0,
    });

  const provider: ChainProvider = {
    async getLatestBlock(): Promise<bigint> {
      let result: unknown;
      try {
        result = await client.getBlockNumber({ cacheTime: 0 });
      } catch (error) {
        throw toUpstreamError("getBlockNumber", error);
      }
      if (typeof result !== "bigint" || result < 0n) {
        throw invalidResponse("getBlockNumber", `block number is ${typeof result}`);
      }
      return result;
    },

    async getUsdcTransfers(query: UsdcTransferQuery): Promise<ChainTransfer[]> {
      if (query.fromBlock > query.toBlock || query.fromBlock < 0n) {
        throw new Error(`invalid block range ${query.fromBlock}..${query.toBlock}`);
      }
      let logs: unknown;
      try {
        // eth_getLogs filtered server-side by contract, event signature and the indexed
        // recipient (topics[2] = to) — plus the indexed sender (topics[1] = from) when a
        // payer is declared — over exactly one block range, never truncated.
        logs = await client.getLogs({
          address: USDC_CONTRACT_ADDRESS,
          event: TRANSFER_EVENT,
          args:
            query.payer === null
              ? { to: getAddress(query.recipient) }
              : { from: getAddress(query.payer), to: getAddress(query.recipient) },
          fromBlock: query.fromBlock,
          toBlock: query.toBlock,
          strict: true,
        });
      } catch (error) {
        throw toUpstreamError("getLogs", error);
      }
      if (!Array.isArray(logs)) {
        throw invalidResponse("getLogs", "result is not an array");
      }
      return logs.map((log) => toChainTransfer(log, query));
    },

    async getBlockTimestamp(blockNumber: bigint): Promise<Date> {
      let block: unknown;
      try {
        block = await client.getBlock({ blockNumber, includeTransactions: false });
      } catch (error) {
        throw toUpstreamError("getBlock", error);
      }
      const header = (block ?? {}) as { number?: unknown; timestamp?: unknown };
      if (header.number !== blockNumber) {
        throw invalidResponse("getBlock", "block number does not match the request");
      }
      if (typeof header.timestamp !== "bigint" || header.timestamp <= 0n || header.timestamp > 253_402_300_799n) {
        throw invalidResponse("getBlock", "block timestamp malformed");
      }
      // Seconds since epoch fit a JavaScript number exactly up to year 9999.
      return new Date(Number(header.timestamp) * 1000);
    },

    async findLastBlockAtOrBefore(at: Date, range: BlockRange): Promise<bigint | null> {
      const outcome = await findLastBlockAtOrBefore((blockNumber) => provider.getBlockTimestamp(blockNumber), at, range);
      return outcome.blockNumber;
    },
  };
  return provider;
}
