# stacksindex

Lightweight Stacks smart contract event indexer: historical sync from the Hiro
API with Clarity decoding, ordered handler execution, and crash-safe
checkpoints.

## Install

```bash
pnpm add stacksindex @electric-sql/pglite drizzle-orm
```

## Usage

```ts
import { createHistoricalRuntime, createLogger } from "stacksindex";

const runtime = createHistoricalRuntime({
  logger: createLogger({ level: 2 }),
  db, // PgliteDatabase | NodePgDatabase
  network: "mainnet", // "mainnet" | "testnet" | { url, chainId? }
  apiKey: process.env.HIRO_API_KEY, // sent as x-api-key
});

const result = await runtime.run([
  {
    contractId: "SP….my-contract",
    startBlock: 150_000,
    endBlock: 151_181,
    async handler(event, context) {
      // ...
    },
  },
]);

if (result.isErr()) {
  console.error(result.error);
}
```

The runtime migrates the sync-store schema automatically (`migrate()` is also
exported for manual use).

## API

### `createHistoricalRuntime(context)`

| Option    | Type                                          | Default     | Description                                           |
| --------- | --------------------------------------------- | ----------- | ----------------------------------------------------- |
| `logger`  | `Logger`                                      | —           | `createLogger({ level })`                             |
| `db`      | `PgliteDatabase \| NodePgDatabase`            | —           | Sync store database                                   |
| `network` | `"mainnet" \| "testnet" \| { url, chainId? }` | `"mainnet"` | API endpoint + chain id used to namespace stored data |
| `apiKey`  | `string`                                      | —           | Sent as the `x-api-key` header                        |

Returns `{ run(filters) }`. `run` resolves a `Result<void, Error>`:

- fetches the contract's `smart_contract_log` events via cursor pagination
- enriches them with transactions and blocks
- stores raw rows in the sync store (idempotent upserts)
- dispatches events to handlers in global block order
- commits a checkpoint after each batch; restarts resume from it

### `Filter`

| Field         | Description                                            |
| ------------- | ------------------------------------------------------ |
| `contractId`  | Fully qualified contract id (`address.name`)           |
| `handler`     | `(event, context) => Promise<void>`                    |
| `startBlock?` | Skip events below this height during processing        |
| `endBlock?`   | Stop syncing and processing at this height (inclusive) |

### `HandlerEvent`

Extends the API's smart contract log with sync metadata plus:

- `decoded: ClarityValue | undefined` — parsed `event.contract_log.value.hex`;
  `undefined` when decoding fails (raw `hex`/`repr` remain available)
- `block_height`, `block_time`, `tx_index`, `sender_address`

### `HandlerContext`

- `db` — the sync store database passed at construction
- `client.callReadOnly(contractId, functionName, { args?, sender? })` —
  read-only contract calls, returning `Result<CallReadResponse, StacksApiError>`

### Clarity helpers

- `decodeClarityValue(hex)` — decode any hex-encoded Clarity value
- `decodeClarityValueUnwrapped(hex)` — decode + unwrap `(ok …)`/`(some …)`;
  returns `undefined` instead of throwing
- `formatPrincipal({ address, contract_name? })`
- `ClarityTypeID`, `ClarityValue`, `decodeStacksAddress` re-exported from
  `@stacks/codec`

### Utilities

- `migrate(db, { migrationsFolder? })` — apply sync-store migrations (PGlite
  or node-postgres)
- `syncStore` — low-level sync store access (`insertBlocks`,
  `getEvents`, `upsertSyncProgress`, `upsertCheckpoint`, …); useful for
  seeding a resume cursor
- `datasourceStacksApi` — typed Hiro API client with retries/rate-limit
  handling
- `resolveNetwork`, `createLogger`, `parseCursor`/`buildCursor`
- Errors: `StacksApiUnexpectedError`, `StacksApiResponseError`,
  `StacksApiRateLimitError`, `StacksApiParseError`, `HandlerExecutionError`

## Known limitations (POC)

- Only `smart_contract_log` events are persisted; STX/FT/NFT asset events are
  fetched but not stored.
- Historical only — no realtime tail.
- First-cursor discovery walks the address-transactions endpoint backwards,
  which can time out on very large contracts. Seed a resume cursor via
  `syncStore.upsertSyncProgress` to start from a known position instead.
