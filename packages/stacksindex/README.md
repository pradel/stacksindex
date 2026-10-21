# stacksindex

A simple, open-source indexer for the Stacks blockchain: historical backfill, then live sync of new blocks.

[![npm version](https://img.shields.io/npm/v/stacksindex.svg)](https://www.npmjs.com/package/stacksindex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`stacksindex` lets you backfill smart contract events, follow new blocks as they are mined, execute user-defined handlers to derive custom relational state, and query historical contract data at specific block heights.

Three entrypoints ship with the package:

- **`stacksindex`** — promise-native API for scripts, CLIs and Node services.
- **`stacksindex/effect`** — Effect-native services and layers.
- **`stacksindex/clarity`** — the Clarity codec (`decodeHex`, `cvToJSON`, …); see [`stacksindex/clarity`](#stacksindexclarity).

---

## Features

- **Simple & Open-Source**: Focused on developer simplicity with zero unnecessary abstractions.
- **Reliable Historical Backfill**: Automatically discovers contract deployment blocks and initial event cursors to paginate backwards or forwards seamlessly.
- **Live Sync**: After the backfill, follow new blocks by polling the API or over its websocket, fetching each block's events or each contract's newest logs, whichever costs fewer requests.
- **Embedded or External Database**: First-class support for embedded [PGlite](https://pglite.electric-sql.com/) (zero configuration) or production PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/).
- **Time-Travel Read-Only Calls**: Query contract state (`client.callReadOnly`) automatically pinned to the exact block height of the event being processed.
- **Clarity Codec Built-in**: Prints are decoded to plain JavaScript values and parsed by an optional schema into typed `event.data`; the codec ships as `stacksindex/clarity`.
- **Crash Recovery**: Checkpointing and resume progress stored directly in the database so sync resumes where it left off. Unfinalized data is replayed after a restart, so reorgs are handled automatically.
- **Atomic Handler Writes**: Handler writes through `context.db` commit in the same transaction as the indexing checkpoint, so a crash or a failed batch never applies an event twice.
- **Monitoring**: Sync, indexing, live sync, reorg and API metrics pushed over OTLP to Prometheus or any OpenTelemetry backend, plus a status call for readiness probes.

---

## Installation

```bash
pnpm add stacksindex @electric-sql/pglite drizzle-orm
```

_(or via `npm install` / `yarn add` / `bun add`)_

---

## Quickstart (Promise)

```ts
import { defineRelations } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { defineIndexer, pglite } from "stacksindex";

// Your tables live in the indexer database, next to the indexer's own tables.
export const mints = pgTable("mints", {
  id: text().primaryKey(), // `${txId}:${eventIndex}`
  blockHeight: integer("block_height").notNull(),
});

// Optional: enables typed `db.query.mints.findMany()`.
export const relations = defineRelations({ mints });

// 1. Define the contracts to index, by name
export const indexer = defineIndexer({
  relations,
  contracts: {
    satoshibles: {
      id: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles",
      startBlock: 47784, // optional: start indexing from this block height
      endBlock: "latest", // optional: stop at a specific height or "latest"
    },
  },
});

// 2. Write one handler per contract, here or in its own module
const satoshibles = indexer.handler("satoshibles", async (event, { db, logger }) => {
  logger.info("Received print", { block: event.block.height, txId: event.txId });

  // Commits together with the indexer checkpoint
  await db
    .insert(mints)
    .values({ id: `${event.txId}:${event.eventIndex}`, blockHeight: event.block.height })
    .onConflictDoNothing();
});

// 3. Open the database, apply your drizzle-kit migrations and sync up to the chain tip
await using app = await indexer.create({
  database: pglite("./indexer.db"), // or postgres("postgres://user:pass@host:5432/db")
  migrations: "./drizzle",
  chain: "mainnet",
  api: { apiKey: process.env.HIRO_API_KEY }, // optional: higher rate limits
  handlers: { satoshibles },
});

const result = await app.run();

console.log(`Indexed ${result.eventsProcessed} events`);
```

`defineIndexer` validates the contracts synchronously and throws `ConfigurationError` on an invalid id (`<principal>.<contract-name>`), a duplicate id, or invalid `startBlock`/`endBlock`. `create` requires a handler for every contract (checked at compile time) and owns the database lifecycle: call `app.close()` (or use `await using` as above) to release resources.

---

## Writing Data

Put your tables in the indexer database and write them through `context.db` in your handlers. `context.db` is scoped to the transaction that also stores the indexing checkpoint, so a batch's writes and its progress commit together or not at all. See [Crash Recovery & Reorgs](#crash-recovery--reorgs) for what this guarantees.

- **Layout**: the indexer's tables live in the `stacksindex` Postgres schema; `public` is yours. Point drizzle-kit at the same database with `schemaFilter: ["public"]` so it ignores the indexer's tables.
- **Migrations**: generate them with `drizzle-kit generate` and pass their folder as `migrations`; they are applied when the database opens, after the indexer's own, and tracked in drizzle's default `drizzle.__drizzle_migrations`.
- **Typed queries**: pass `relations` from `defineRelations` to `defineIndexer` to type `db.query` in handlers and on `app.db`.
- **Reads**: `app.db` (`indexer.Db` with the Effect API) queries the same database outside any batch, e.g. from an API. PGlite runs one query at a time, so on PGlite reads wait for the batch in progress; on Postgres they don't.

---

## Typed Prints

Each contract can declare a `print` schema. Every print is decoded from Clarity to a plain value (uints and ints become `bigint`, tuples objects, `(ok x)` `{ ok: x }`, `none` `null`) and parsed by the schema into `event.data`, typed by the schema's output. Without `print`, `event.data` is the decoded `ClarityJsonValue`.

With the promise API, `print` is any [Standard Schema](https://standardschema.dev) (zod, valibot, arktype, or Effect's `Schema.toStandardSchemaV1`); with the Effect API it is an Effect `Schema`.

```ts
import { z } from "zod";
import { defineIndexer } from "stacksindex";

const SwapLog = z.object({
  object: z.literal("pool"),
  action: z.literal("swap-x-for-y"),
  data: z.object({ dx: z.bigint(), dy: z.bigint() }),
});

const indexer = defineIndexer({
  contracts: {
    pool: {
      id: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.amm-pool-v2-01",
      print: SwapLog,
      onInvalid: "skip", // default "fail"
    },
  },
});

const pool = indexer.handler("pool", (event) => {
  event.data.data.dx; // bigint
});
```

A print that doesn't match fails the batch with `EventDecodeError` (`contract`, `contractId`, `txId`, `eventIndex`, `message`) by default. With `onInvalid: "skip"` it is logged at `Warning` and skipped, and not counted as processed.

### Event payload

| Property     | Type                                     | Description                                                                        |
| ------------ | ---------------------------------------- | ---------------------------------------------------------------------------------- |
| `type`       | `"print"`                                | Event kind.                                                                        |
| `contract`   | `string`                                 | Definition name (the key in `contracts`).                                          |
| `contractId` | `string`                                 | Fully qualified contract identifier.                                               |
| `txId`       | `string`                                 | Transaction id.                                                                    |
| `eventIndex` | `number`                                 | Index of the event in its transaction.                                             |
| `data`       | `print` output \| `ClarityJsonValue`     | The decoded print, parsed by the contract's `print` schema.                        |
| `raw`        | `{ hex, repr, topic }`                   | The print as the Stacks API returned it.                                           |
| `block`      | `{ height, time, hash, indexBlockHash }` | Block of the event; `time` in Unix seconds. `indexBlockHash` pins read-only calls. |
| `tx`         | `{ index, sender }`                      | Position of the transaction in its block and its sender.                           |

---

## Live Sync

`live` runs the same historical pass, then keeps indexing new blocks as they are mined:

```ts
await using app = await indexer.create({
  database: pglite("./indexer.db"),
  live: {
    transport: "polling", // or "websocket"
    pollingInterval: 5000,
  },
  handlers: { satoshibles },
});

// Resolves once every contract reached its `endBlock`, or when `close()` is called.
await app.live();
```

- **New blocks**: `"polling"` (default) asks the API for the latest block every `pollingInterval` milliseconds. `"websocket"` subscribes to new blocks on `/extended/v1/ws`; after 9 consecutive connection failures it falls back to polling for good.
- **Fetching**: each new head is fetched the cheaper way. Block by block, it lists the block's transactions and their events. Contract by contract, it reads each contract's newest logs page. Several heads that arrive while one is processed are fetched together.
- **Reorgs**: a head whose parent is the previous head needs no check. Otherwise the previous head's hash is compared with the canonical chain, and a reorged range is replayed as described in [Crash Recovery & Reorgs](#crash-recovery--reorgs).
- **Errors**: API failures are retried with the next head; `live` fails only after 10 consecutive failures spanning 10 minutes. Handler, decode, database and finalized-reorg errors fail it at once.

Without an API key the Hiro API allows 50 requests per minute. Polling every 5 seconds uses 12 of them; lower `pollingInterval` only with an API key, or use the websocket.

---

## Effect API

`stacksindex/effect` exposes the same indexer as Effect handlers and a layer:

```ts
import { Effect, Schema } from "effect";
import { defineIndexer, Indexer, pglite } from "stacksindex/effect";

import { mints, relations } from "./schema.ts";

const MintLog = Schema.Struct({ action: Schema.Literal("mint"), id: Schema.BigInt });

const indexer = defineIndexer({
  relations,
  contracts: {
    satoshibles: { id: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles", print: MintLog },
  },
});

const satoshibles = indexer.handler("satoshibles", (event) =>
  Effect.gen(function* () {
    // Inside a handler, the batch transaction: writes commit with the checkpoint.
    const db = yield* indexer.Db;

    yield* db
      .insert(mints)
      .values({ id: `${event.txId}:${event.eventIndex}`, blockHeight: event.block.height })
      .onConflictDoNothing();
  }),
);

const program = Effect.gen(function* () {
  const app = yield* Indexer;

  // `app.live` follows new blocks after the historical pass.
  const result = yield* app.run;
  yield* Effect.log(`Indexed ${result.eventsProcessed} events`);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(
      indexer.layer({
        database: pglite("./indexer.db"),
        migrations: "./drizzle",
        chain: "mainnet",
        api: { apiKey: process.env.HIRO_API_KEY },
        handlers: { satoshibles },
      }),
    ),
  ),
);
```

- **`indexer.handler(name, fn)`** types a handler from its contract's definition: `(event) => Effect<void, E, R>`.
- **`indexer.Db`** yields the database typed by `relations`; inside a handler it is the batch transaction. **`indexer.Client`** yields the read-only client pinned to the handled event's block (handlers only); its `callReadOnly` returns an `Effect`.
- **`indexer.layer(options)`** takes the same options as `create` and provides `Indexer` and `IndexerDatabase`, Effect's pretty console logger and, with `telemetry.otlp`, the metrics exporter. It fails with `ConfigurationError`, `DatabaseError` or `MigrationError`. Services your handlers require beyond `IndexerDatabase` and `HandlerClient` become requirements of the layer: provide them to it.
- **`Indexer`** is the service: `run` (`Effect<RunResult, IndexerError>`), `live` (`Effect<void, IndexerError>`; interrupting the fiber stops live sync) and `status` (the current [`IndexerStatus`](#indexerstatus)).

---

## Time-Travel Read-Only Contract Calls

Inside your event handlers, you can perform read-only contract calls that are automatically pinned to the block of the event being processed, so they see the contract state as of that block. Both typed calls (using a Clarity ABI) and untyped calls are supported, and both return decoded Clarity values:

```ts
const pool = indexer.handler("pool", async (event, { client }) => {
  // Reads the contract state as of the event's block
  const supply = await client.callReadOnly({
    abi: myContractAbi,
    contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.my-token",
    functionName: "get-total-supply",
  });

  if ("ok" in supply) {
    const totalSupply = supply.ok;
    // ...
  }
});
```

Clarity-level failures (`okay: false`) reject with `ReadOnlyCallError`. With the Effect API, `yield* indexer.Client` and call the same `callReadOnly`, which returns an `Effect`.

Pass `tip` to read at another block. It takes the block's index block hash (`index_block_hash` in the Stacks API), the only form the node pins reads to; `event.block.indexBlockHash` holds the one of the event's block.

---

## Crash Recovery & Reorgs

Checkpoints and per-contract sync progress live in the indexer database, so `run` and `live` resume where they left off. The indexer's tables live in the `stacksindex` Postgres schema and are created when the indexer opens the database; `public` is left to your tables.

Re-running on a schedule is cheap: a contract that is already synced costs a single request to the newest page of its logs, plus two requests per run (the chain tip and the reorg check). Events mined while a run is in progress are indexed by the next run, so handlers always see events in chain order.

Every run, and every new head in live sync, checks for reorgs: it compares the hash of the chain tip saved by the previous pass with the canonical chain. When a reorg replaced stored blocks, the indexer rewinds to the newest stored block that is still canonical, refetches from there and replays the range through your handlers. Without a reorg nothing is replayed.

Set `finality` to the deepest reorg you want handled automatically (default `6`). A reorg that replaces a block at or below `finalizedBlockHeight` fails with `ReorgError` instead of silently changing data reported as final; re-sync from an empty indexer database to recover. With `finality: 0`, any reorg that reaches indexed blocks fails this way.

Handler writes through `context.db` commit in the same transaction as the checkpoint, so a crash or a failed batch never applies an event twice. A rewind (a chain reorg, or a start without a sync anchor) re-runs handlers for the unfinalized blocks it replays without undoing their writes: keep writes replay-safe (upsert or insert-if-absent by primary key) for that window. Writes to other systems (another database, an HTTP call) are at-least-once.

---

## Monitoring

stacksindex records [OpenTelemetry](https://opentelemetry.io/)-style metrics for sync, indexing, live sync, reorgs and Stacks API calls, and pushes them over OTLP/HTTP when `telemetry.otlp` is set. It serves no HTTP endpoint: point it at an OpenTelemetry Collector or any backend with an OTLP receiver.

```ts
await using app = await indexer.create({
  database: pglite("./indexer.db"),
  handlers: { satoshibles },
  telemetry: {
    otlp: {
      baseUrl: "http://localhost:4318", // OpenTelemetry Collector; `/v1/metrics` is appended
      // headers: { authorization: `Bearer ${process.env.OTLP_TOKEN}` },
      // exportInterval: 10_000,
      // temporality: "cumulative", // "delta" for Datadog or Dynatrace
      // resource: { serviceName: "my-indexer", serviceVersion: "1.2.3", attributes: { env: "prod" } },
    },
  },
});
```

Metrics are exported every `exportInterval` milliseconds and once more on `close()`, so a short `run` script still delivers its final values.

To send them straight to Prometheus, start it with its OTLP receiver enabled and use its OTLP path as `baseUrl`:

```bash
prometheus --web.enable-otlp-receiver
```

```ts
telemetry: { otlp: { baseUrl: "http://localhost:9090/api/v1/otlp" } },
```

With the Effect API, pass the same `telemetry` option to `indexer.layer`, or leave it unset and compose Effect's exporter yourself. Metrics live in Effect's default `MetricRegistry`, so any `OtlpMetrics` layer in the same runtime exports them:

```ts
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpMetrics, OtlpSerialization } from "effect/observability";

const MetricsLive = OtlpMetrics.layer({
  url: "http://localhost:4318/v1/metrics",
  resource: { serviceName: "my-indexer" }, // required unless OTEL_SERVICE_NAME is set
}).pipe(Layer.provide(Layer.mergeAll(OtlpSerialization.layerProtobuf, FetchHttpClient.layer)));

const IndexerLive = indexer.layer({ database: pglite("./indexer.db"), handlers: { satoshibles } });

// The exporter flushes a last snapshot when `program` ends and the layers close.
await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(IndexerLive, MetricsLive))));
```

### Metrics

Every series carries a `chain_id` attribute (`"1"` for mainnet). Per-contract series carry `contract` with the definition name (the key in `contracts`) and `contract_id` with the contract ID. Effect's exporter sends each metric's unit as a `unit` attribute as well.

Names follow OpenTelemetry conventions. Prometheus renders dots as underscores and appends type and unit suffixes: `stacksindex.sync.pages` becomes `stacksindex_sync_pages_total`, `stacksindex.indexing.handler.duration` becomes `stacksindex_indexing_handler_duration_milliseconds` (with `_bucket`, `_sum` and `_count` series), and `stacksindex.indexing.block_timestamp` becomes `stacksindex_indexing_block_timestamp_seconds`. Durations are in milliseconds.

| Metric                                    | Type      | Attributes                                                                    | Description                                                                |
| ----------------------------------------- | --------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `stacksindex.api.request.duration`        | histogram | `endpoint` (client method), `outcome` (`success` \| `failure`)                | Duration of a Stacks API request including retries.                        |
| `stacksindex.api.responses`               | counter   | `endpoint`, `status` (`2xx` \| `3xx` \| `4xx` \| `429` \| `5xx` \| `network`) | HTTP attempts against the Stacks API, retried 429s included.               |
| `stacksindex.sync.pages`                  | counter   | `contract`, `kind` (`backfill` \| `catchup`)                                  | Contract-log pages fetched from the Stacks API.                            |
| `stacksindex.sync.transactions`           | counter   | `contract`                                                                    | Transactions fetched to give stored events their context.                  |
| `stacksindex.sync.events`                 | counter   | `contract`, `path` (`historical` \| `block`)                                  | Smart contract log events stored in the sync store.                        |
| `stacksindex.sync.errors`                 | counter   | `mode` (`historical` \| `live`)                                               | Failed sync passes.                                                        |
| `stacksindex.sync.block`                  | gauge     | `contract`                                                                    | Height up to which every event of the contract is stored.                  |
| `stacksindex.sync.complete`               | gauge     | `contract`                                                                    | `1` once the contract synced through its `endBlock`, else `0`.             |
| `stacksindex.historical.total_blocks`     | gauge     |                                                                               | Blocks the current historical pass must cover.                             |
| `stacksindex.historical.completed_blocks` | gauge     |                                                                               | Blocks the current historical pass has covered.                            |
| `stacksindex.chain.tip_block`             | gauge     |                                                                               | Chain tip height read at the start of the latest pass.                     |
| `stacksindex.indexing.block`              | gauge     |                                                                               | Height through which every event has been indexed (the checkpoint).        |
| `stacksindex.indexing.block_timestamp`    | gauge     |                                                                               | Block time of the checkpoint, in Unix seconds.                             |
| `stacksindex.indexing.finalized_block`    | gauge     |                                                                               | Highest indexed block that is final.                                       |
| `stacksindex.indexing.events`             | counter   | `contract`                                                                    | Events passed to handlers in committed batches.                            |
| `stacksindex.indexing.handler.duration`   | histogram | `contract`                                                                    | Duration of one handler call.                                              |
| `stacksindex.indexing.handler.errors`     | counter   | `contract`                                                                    | Handler calls that failed.                                                 |
| `stacksindex.indexing.batch.duration`     | histogram |                                                                               | Duration of one indexing batch: handlers plus checkpoint, one transaction. |
| `stacksindex.live.is_realtime`            | gauge     |                                                                               | `1` while `live` follows new blocks, else `0`.                             |
| `stacksindex.live.head_block`             | gauge     |                                                                               | Height of the latest chain head received.                                  |
| `stacksindex.live.block_arrival_latency`  | histogram |                                                                               | Time between a block's timestamp and its head being processed.             |
| `stacksindex.live.pass.duration`          | histogram | `fetch` (`blocks` \| `contracts`)                                             | Duration of one live pass (fetch, store and index).                        |
| `stacksindex.live.consecutive_failures`   | gauge     |                                                                               | Consecutive failed live passes; `live` fails once its budget is exhausted. |
| `stacksindex.live.websocket.reconnects`   | counter   |                                                                               | Websocket reconnection attempts for new heads.                             |
| `stacksindex.live.transport_fallbacks`    | counter   |                                                                               | Switches from the websocket transport to polling.                          |
| `stacksindex.live.stalls`                 | counter   |                                                                               | Times no new head arrived within the stall window.                         |
| `stacksindex.reorgs`                      | counter   |                                                                               | Chain reorganizations that replaced stored blocks.                         |
| `stacksindex.reorg.depth`                 | histogram |                                                                               | Blocks rewound and replayed by one reorg.                                  |

### Status and readiness

`app.status()` (`yield* app.status` with the Effect API) reports the indexer's phase and its stored progress. `ready` turns `true` once the historical pass finished (`phase` is `"live"` or `"done"`), which makes it a readiness probe for a service that runs `live`:

```ts
import { createServer } from "node:http";

createServer(async (_request, response) => {
  try {
    const status = await app.status();

    response.writeHead(status.ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(status));
  } catch {
    response.writeHead(503).end();
  }
}).listen(8080);
```

See [`IndexerStatus`](#indexerstatus) for the fields. `status()` rejects while the indexer tables are missing or the database is unreachable.

### Troubleshooting

The exporter logs its target once at `Info` when the indexer starts. Failed exports are logged only at `Debug` (after which the exporter pauses for 60 seconds), so set `logLevel: "Debug"` when no metrics arrive.

---

## API Reference

### `defineIndexer({ contracts, relations? })`

`relations` (from drizzle's `defineRelations`) types `db.query`. Each entry of `contracts` is keyed by its definition name:

| Property     | Type                 | Default                 | Description                                                                                  |
| ------------ | -------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `id`         | `string`             | _Required_              | Fully qualified contract identifier (`<principal>.<contract-name>`).                         |
| `startBlock` | `number`             | _Deployment block_      | Start indexing from this block height.                                                       |
| `endBlock`   | `number \| "latest"` | _All available history_ | Block height to stop at, or `"latest"` for the chain tip read when a run starts.             |
| `print`      | `Schema`             | `undefined`             | Standard Schema (promise) or Effect `Schema` (Effect) parsing every print into `event.data`. |
| `onInvalid`  | `"fail" \| "skip"`   | `"fail"`                | On a `print` mismatch: fail with `EventDecodeError`, or log and skip the event.              |

The definition exposes `handler(name, fn)` and `create(options)` (promise) or `Db`, `Client`, `handler(name, fn)` and `layer(options)` (Effect).

### `create(options)` / `layer(options)`

| Option                          | Type                                             | Default                          | Description                                                                                                                                        |
| ------------------------------- | ------------------------------------------------ | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`                      | `Database`                                       | _Required_                       | Indexer storage: `pglite(directory?)` (in memory without a directory) or `postgres(connectionString)`.                                             |
| `handlers`                      | `{ [name]: handler }`                            | _Required_                       | One handler per defined contract.                                                                                                                  |
| `migrations`                    | `string`                                         | `undefined`                      | Folder of your drizzle-kit migrations, applied when the database opens, after the indexer's own.                                                   |
| `chain`                         | `"mainnet" \| "testnet" \| { id, apiUrl }`       | `"mainnet"`                      | `"mainnet"` (chain `1`, `https://api.hiro.so`), `"testnet"` (chain `2147483648`, `https://api.testnet.hiro.so`), or a custom chain ID and API URL. |
| `api.url`                       | `string`                                         | _Chain default_                  | Stacks API URL; overrides the chain's.                                                                                                             |
| `api.apiKey`                    | `string`                                         | `undefined`                      | Optional Hiro API key.                                                                                                                             |
| `finality`                      | `number`                                         | `6`                              | Depth, in blocks, of reorgs handled by replaying; deeper reorgs fail with `ReorgError`.                                                            |
| `live.transport`                | `"polling" \| "websocket"`                       | `"polling"`                      | How `live` detects new blocks.                                                                                                                     |
| `live.pollingInterval`          | `number`                                         | `5000`                           | Milliseconds between polls for the latest block (minimum `100`). Also used after a websocket falls back to polling.                                |
| `live.webSocketUrl`             | `string`                                         | `/extended/v1/ws` (API)          | Websocket endpoint; defaults to the API URL with `wss:` (or `ws:`) and `/extended/v1/ws`.                                                          |
| `logLevel`                      | `LogLevel`                                       | `"Info"`                         | Minimum log level for the console logger.                                                                                                          |
| `telemetry.otlp.baseUrl`        | `string`                                         | _Required with `otlp`_           | OTLP/HTTP base URL; `/v1/metrics` is appended. Metrics are not exported without `telemetry.otlp`.                                                  |
| `telemetry.otlp.headers`        | `Record<string, string>`                         | `undefined`                      | Headers sent with every export, e.g. authentication.                                                                                               |
| `telemetry.otlp.exportInterval` | `number`                                         | `10000`                          | Milliseconds between exports (positive integer).                                                                                                   |
| `telemetry.otlp.temporality`    | `"cumulative" \| "delta"`                        | `"cumulative"`                   | `"cumulative"` for Prometheus, `"delta"` for Datadog or Dynatrace.                                                                                 |
| `telemetry.otlp.resource`       | `{ serviceName?, serviceVersion?, attributes? }` | `{ serviceName: "stacksindex" }` | OpenTelemetry resource attached to every export.                                                                                                   |

`postgres` takes a connection string: the driver is managed by the indexer, so an existing `pg.Pool` cannot be passed in.

### Handler context (Promise)

| Property | Description                                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------------------- |
| `db`     | Database scoped to the batch transaction, typed by `relations`; writes commit together with the checkpoint. |
| `client` | Read-only contract client pinned to the event's block (`callReadOnly`).                                     |
| `logger` | Console logger (`info`, `warn`, `error`, `debug`, `trace`) honoring `logLevel`.                             |

### `Indexer` (Promise)

| Member                  | Description                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run()`                 | Syncs and indexes every contract up to the current chain tip; resolves with a `RunResult`.                                                       |
| `live()`                | Runs `run`, then follows new blocks. Resolves when every contract reached its `endBlock` or on `close()`; rejects on a fatal error.              |
| `db`                    | Database handle outside any batch, to query your tables (e.g. from an API) and the indexer's. On PGlite, queries wait for the batch in progress. |
| `status()`              | Resolves with the current [`IndexerStatus`](#indexerstatus).                                                                                     |
| `close()`               | Stops live sync, flushes pending metrics and releases database and runtime resources. Safe to call multiple times.                               |
| `[Symbol.asyncDispose]` | Same as `close()`, enabling `await using`.                                                                                                       |

### RunResult

| Property               | Type                                              | Description                                                                            |
| ---------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `eventsProcessed`      | `number`                                          | Total events passed to handlers during the run.                                        |
| `blockHeight`          | `number \| undefined`                             | Height through which every event has been indexed; `undefined` before the first batch. |
| `finalizedBlockHeight` | `number \| undefined`                             | Highest finalized block after the run; `undefined` when no checkpoint exists.          |
| `contracts`            | `Record<name, { eventsProcessed, blockHeight? }>` | Per contract, keyed by definition name: events handled and highest processed block.    |

### IndexerStatus

| Property     | Type                                                       | Description                                                                                                                    |
| ------------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `chainId`    | `number`                                                   | Chain the indexer runs on.                                                                                                     |
| `phase`      | `"idle" \| "backfill" \| "live" \| "done" \| "failed"`     | `idle` before any `run`/`live` or after an interruption; `failed` after the last call failed.                                  |
| `ready`      | `boolean`                                                  | `true` once the historical pass finished (`phase` is `"live"` or `"done"`).                                                    |
| `checkpoint` | `{ blockHeight, blockTime, finalizedBlockHeight } \| null` | Height through which every event has been indexed; `null` before the first batch. Survives restarts.                           |
| `anchor`     | `{ blockHeight } \| null`                                  | Chain tip read at the start of the latest pass.                                                                                |
| `contracts`  | `Record<name, { syncedBlockHeight, isComplete }>`          | Stored sync progress of every defined contract, keyed by definition name; `syncedBlockHeight` is `null` before its first sync. |

`phase` is in memory and starts at `"idle"` in every new process; `checkpoint`, `anchor` and `contracts` are read from the indexer database.

### Errors

Both entrypoints export the error classes, each with a `_tag` of the same name:

| Error                   | Raised when                                                                      |
| ----------------------- | -------------------------------------------------------------------------------- |
| `ConfigurationError`    | `defineIndexer`, `create` or `layer` receives an invalid definition or option.   |
| `DatabaseError`         | The database cannot be opened or a query fails.                                  |
| `MigrationError`        | The indexer's or your migrations fail to apply.                                  |
| `EventDecodeError`      | A print does not match its contract's `print` schema (with `onInvalid: "fail"`). |
| `HandlerExecutionError` | A handler throws or fails; carries `contract`, `contractId` and the `cause`.     |
| `ReorgError`            | A reorg replaces a finalized block.                                              |
| `ReadOnlyCallError`     | A read-only call returns a Clarity-level failure.                                |

### `stacksindex/clarity`

The Clarity codec the indexer uses, for values outside handlers: `decodeHex(hex)` decodes a hex-encoded value to a plain `ClarityJsonValue`; `decodeClarityValue(hex)` decodes it to a `ClarityValue` AST (typed by `ClarityTypeID`) that `cvToJSON(value)` converts; `decodeClarityWithSchema(schema)(hex)` decodes and parses with an Effect `Schema`; `encodeUint(n)` encodes a `bigint` as a uint argument.

```ts
import { decodeHex, encodeUint } from "stacksindex/clarity";

decodeHex("0x0703"); // { ok: true }
encodeUint(1n); // "0x0100000000000000000000000000000001"
```

---

## Examples

Check out [`examples/dex-alex`](./examples/dex-alex) for a complete working example indexing the ALEX DEX pool contracts with relational tables, typed read-only calls, and Zod validation using the promise API.

Check out [`examples/dex-alex-effect`](./examples/dex-alex-effect) for the same indexer written entirely with the Effect API (`Effect.gen`, `Schema`, scoped database resources).

---

## License

MIT © [Léo Pradel](https://github.com/pradel)
