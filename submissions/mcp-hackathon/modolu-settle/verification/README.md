# Verification evidence

## Prerequisites

- Review commit: `96194cb3a125bb5ba9063a58e9489167242e193b`
- API base URL: `https://settle-beige-seven.vercel.app/v1`
- Authentication: none. Every call below works anonymously; the only capability is the opaque `pi_…` intent ID returned by the create call, so keep it out of public logs if the intent is real.

All responses carry `X-Request-Id`, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Rate limit: 60 requests / minute / IP on `/v1/*` (HTTP 429 above that).

## 1. Health check

```bash
curl --fail --silent --show-error https://settle-beige-seven.vercel.app/health
```

Expected response (`timestamp` varies):

```json
{"status":"ok","service":"settle","environment":"production","commit":"96194cb3a125bb5ba9063a58e9489167242e193b","timestamp":"2026-09-18T12:00:00.000Z"}
```

## 2. Deployment proof

```bash
curl --fail --silent --show-error https://settle-beige-seven.vercel.app/.well-known/xagent-verification.json
```

Expected response:

```json
{"schemaVersion":1,"slug":"modolu-settle","commit":"96194cb3a125bb5ba9063a58e9489167242e193b"}
```

The `commit` values in steps 1 and 2 are the same platform-provided value; if either is unavailable the route answers `500 {"error":{"code":"INTERNAL_ERROR",…}}` rather than a fabricated commit.

## 3. Capability call

### 3a. Declare an expected payment

Use any Base addresses; the example below uses the native USDC contract as a stand-in recipient and a well-known public address as the payer. `expiresAt` must be a UTC timestamp between now and seven days out.

```bash
curl --fail --silent --show-error \
  --request POST https://settle-beige-seven.vercel.app/v1/payment-intents \
  --header "content-type: application/json" \
  --data '{
    "externalReference": "REVIEW-001",
    "chain": "base",
    "asset": "USDC",
    "amount": "25.00",
    "recipient": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payer": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "expiresAt": "2026-09-25T00:00:00Z",
    "requiredConfirmations": 3
  }'
```

Expected success response (`201 Created`; `id`, `createdAt` vary):

```json
{"id":"pi_<32 url-safe characters>","status":"pending","externalReference":"REVIEW-001","chain":"base","asset":"USDC","expectedAmount":"25.00","receivedAmount":"0.00","remainingAmount":"25.00","recipient":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payer":"0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045","requiredConfirmations":3,"matchConfidence":"none","paidAt":null,"createdAt":"2026-09-18T12:00:00.000Z","expiresAt":"2026-09-25T00:00:00.000Z"}
```

The intent's matching window starts at the Base block after the latest block read at creation, so no earlier transfer can satisfy it.

### 3b. Read the persisted state

```bash
curl --fail --silent --show-error https://settle-beige-seven.vercel.app/v1/payment-intents/<id>
```

Returns the same resource shape with `200`.

### 3c. Reconcile against Base

```bash
curl --fail --silent --show-error --request POST \
  https://settle-beige-seven.vercel.app/v1/payment-intents/<id>/reconcile
```

Settle reads the latest Base block, queries native-USDC `Transfer` logs from the payer to the recipient inside the window, computes confirmation depth (`latest − block + 1`), applies the evidence atomically and returns the updated resource. With no payment sent, the response is the intent with `"status":"pending"`; after a matching transfer it becomes `detected` (under the confirmation threshold), then `paid` (or `partial` / `overpaid`), with `receivedAmount`, `remainingAmount`, `matchConfidence` and `paidAt` filled from onchain evidence. Repeated calls are idempotent: evidence is keyed by `(transaction hash, log index)` and totals are recomputed, never incremented.

### 3d. Evidence

```bash
curl --fail --silent --show-error \
  "https://settle-beige-seven.vercel.app/v1/payment-intents/<id>/evidence?limit=50"
```

Expected response before any payment:

```json
{"evidence":[],"nextCursor":null}
```

After a matching transfer, each row looks like:

```json
{"transactionHash":"0x<64 hex>","logIndex":4,"blockNumber":"51447828","from":"0x…","to":"0x…","amount":"25.00","confirmations":25,"blockTimestamp":"2026-09-17T22:43:23.000Z","association":"matched"}
```

`association` is `matched` (counts toward the obligation), `candidate` (seen for an ambiguous payer-less intent; never counted) or `orphaned` (no longer canonical; never counted).

### Safe error behavior

```bash
# unknown field → 400 VALIDATION_ERROR
curl --silent --request POST https://settle-beige-seven.vercel.app/v1/payment-intents \
  --header "content-type: application/json" \
  --data '{"chain":"base","asset":"USDC","amount":"1","recipient":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","expiresAt":"2026-09-25T00:00:00Z","tokenAddress":"0x00"}'
# {"error":{"code":"VALIDATION_ERROR","message":"unknown field(s): tokenAddress","retryable":false}}

# other rail → 400 UNSUPPORTED_CHAIN
# bad address → 400 INVALID_ADDRESS
# unknown intent → 404 INTENT_NOT_FOUND
curl --silent https://settle-beige-seven.vercel.app/v1/payment-intents/pi_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
# {"error":{"code":"INTENT_NOT_FOUND","message":"Payment intent not found","retryable":false}}

# body over 16 KiB, wrong content type, or a body on /reconcile → 400 VALIDATION_ERROR
# blockchain provider unavailable → 503 {"error":{"code":"UPSTREAM_UNAVAILABLE","message":"Blockchain provider is temporarily unavailable","retryable":true}}
#   (payment state and evidence are left unchanged; retry later)
# more than 60 requests/minute from one IP on /v1/* → 429
```

## 4. Real payment evidence

**PENDING.** This section is completed before the final submission with a fresh intent created through this deployment, one real native Base USDC transfer sent from the declared payer to the recipient outside Settle (Settle never signs or sends transactions), the reconcile responses showing the `detected` → `paid` transition, the `GET …/evidence` response with the real transaction hash, block number, confirmations and block timestamp, and a Basescan link for the transaction. No such transfer has been recorded here yet; nothing in this file should be read as a claim that one has.
