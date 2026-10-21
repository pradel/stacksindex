# stacksindex

A simple, open-source indexer for the Stacks blockchain: historical backfill, then live sync of new blocks.

[![npm version](https://img.shields.io/npm/v/stacksindex.svg)](https://www.npmjs.com/package/stacksindex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`stacksindex` lets you backfill smart contract events, follow new blocks as they are mined, execute user-defined handlers to derive custom relational state, and query historical contract data at specific block heights.

Three entrypoints ship with the package:

- **`stacksindex`** — promise-native API for scripts, CLIs and Node services.
- **`stacksindex/effect`** — Effect-native services and layers.
- **`stacksindex/clarity`** — Clarity codec: `decodeHex`, `cvToJSON`, `decodeClarityValue`, `decodeClarityWithSchema` (Effect Schema), `encodeUint`, `ClarityTypeID`.

---

## Features

- **Simple & Open-Source**: Focused on developer simplicity with zero unnecessary abstractions.
- **Reliable Historical Backfill**: Automatically discovers contract deployment blocks and initial event cursors to paginate backwards or forwards seamlessly.
- **Live Sync**: After the backfill, follow new blocks by polling the API or over its websocket, fetching each block's events or each contract's newest logs, whichever costs fewer requests.
- **Embedded or External Database**: First-class support for embedded [PGlite](https://pglite.electric-sql.com/) (zero configuration) or production PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/).
- **Time-Travel Read-Only Calls**: Query contract state (`client.callReadOnly`) automatically pinned to the exact block height of the event being processed.
- **Clarity Codec Built-in**: Easily decode raw Clarity hex values to plain JavaScript objects (`decodeHex`, `cvToJSON` from `stacksindex/clarity`).
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
import { createIndexer } from "stacksindex";
import { decodeHex } from "stacksindex/clarity";

// Your tables live in the indexer database, next to the indexer's own tables.
const mints = pgTable("mints", {
  id: text().primaryKey(), // `${txId}:${eventIndex}`
  blockHeight: integer("block_height").notNull(),
});

// Optional: enables typed `db.query.mints.findMany()` in handlers.
const relations = defineRelations({ mints });

// 1. Create the indexer: it owns the database and the Stacks API client
await using indexer = await createIndexer({
  database: { kind: "pglite", directory: "./indexer.db" },
  relations,
  chain: "mainnet",
  api: {
    apiKey: process.env.HIRO_API_KEY, // Optional: Stacks / Hiro API key for higher rate limits
  },
  logLevel: "Info",
});

// 2. Create your tables from the migrations drizzle-kit generated for them
await indexer.migrate({ migrationsFolder: "./drizzle" });

// 3. Sync and index one or more contracts up to the current chain tip
const result = await indexer.run({
  contractId: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles",
  startBlock: 47784, // optional: start indexing from this block height
  endBlock: "latest", // optional: stop at a specific height or 'latest'
  async handler(event, { db, logger }) {
    // Decode Clarity event data
    const data = decodeHex(event.contract_log.value.hex);

    logger.info("Received event", { block: event.block_height, txId: event.tx_id });

    // Commits together with the indexer checkpoint
    await db
      .insert(mints)
      .values({ id: `${event.tx_id}:${event.event_index}`, blockHeight: event.block_height })
      .onConflictDoNothing();
  },
});

console.log(`Indexed ${result.eventsProcessed} events`);
```

`createIndexer` owns the database lifecycle. Call `indexer.close()` (or use `await using` as above) to release resources. Pass an array of filters to `run` to index multiple contracts in one pass.

---

## Writing Data

Put your tables in the indexer database and write them through `context.db` in your handlers. `context.db` is scoped to the transaction that also stores the indexing checkpoint, so a batch's writes and its progress commit together or not at all. See [Crash Recovery & Reorgs](#crash-recovery--reorgs) for what this guarantees.

- **Layout**: the indexer's tables live in the `stacksindex` Postgres schema; `public` is yours. Point drizzle-kit at the same database with `schemaFilter: ["public"]` so it ignores the indexer's tables.
- **Migrations**: generate them with `drizzle-kit generate` and apply them with `indexer.migrate({ migrationsFolder })` (`migrate` from `stacksindex/effect`). They are tracked in drizzle's default `drizzle.__drizzle_migrations`, apart from the indexer's.
- **Typed queries**: pass `relations` from `defineRelations` to `createIndexer` (or `Indexer.layerWithDatabase`) to enable `db.query`. Handlers defined inline infer it; type the others with `EventHandler<typeof relations>`.
- **Reads**: `indexer.db` (the `IndexerDatabase` service with the Effect API) queries the same database outside any batch, e.g. from an API. PGlite runs one query at a time, so on PGlite reads wait for the batch in progress; on Postgres they don't.

---

## Live Sync

`live` runs the same historical pass, then keeps indexing new blocks as they are mined:

```ts
await using indexer = await createIndexer({
  database: { kind: "pglite", directory: "./indexer.db" },
  live: {
    transport: "polling", // or "websocket"
    pollingInterval: 5000,
  },
});

// Resolves once every filter reached its `endBlock`, or when `close()` is called.
await indexer.live({
  contractId: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles",
  handler(event) {
    // ...
  },
});
```

- **New blocks**: `"polling"` (default) asks the API for the latest block every `pollingInterval` milliseconds. `"websocket"` subscribes to new blocks on `/extended/v1/ws`; after 9 consecutive connection failures it falls back to polling for good.
- **Fetching**: each new head is fetched the cheaper way. Block by block, it lists the block's transactions and their events. Contract by contract, it reads each contract's newest logs page. Several heads that arrive while one is processed are fetched together.
- **Reorgs**: a head whose parent is the previous head needs no check. Otherwise the previous head's hash is compared with the canonical chain, and a reorged range is replayed as described in [Crash Recovery & Reorgs](#crash-recovery--reorgs).
- **Errors**: API failures are retried with the next head; `live` fails only after 10 consecutive failures spanning 10 minutes. Handler, database and finalized-reorg errors fail it at once.

Without an API key the Hiro API allows 50 requests per minute. Polling every 5 seconds uses 12 of them; lower `pollingInterval` only with an API key, or use the websocket.

---

## Effect API

The same indexer can be composed entirely with Effect services and layers from `stacksindex/effect`:

```ts
import { Effect } from "effect";
import { type EventHandler, Indexer, migrate } from "stacksindex/effect";

import { mints, relations } from "./schema.ts";

const apiKey = process.env.HIRO_API_KEY;

// Writes through `context.db` commit together with the indexer checkpoint.
const handler: EventHandler<typeof relations> = (event, { db }) =>
  db
    .insert(mints)
    .values({ id: `${event.tx_id}:${event.event_index}`, blockHeight: event.block_height })
    .onConflictDoNothing()
    .pipe(Effect.asVoid);

const program = Effect.gen(function* () {
  yield* migrate({ migrationsFolder: "./drizzle" });

  const indexer = yield* Indexer;

  // `indexer.live(filters)` follows new blocks after the historical pass.
  yield* indexer.run([
    { contractId: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles", handler },
  ]);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(
      Indexer.layerWithDatabase({
        database: { kind: "pglite", directory: "./indexer.db" },
        relations,
        chain: "mainnet",
        api: { apiKey },
        logLevel: "Info",
      }),
    ),
  ),
);
```

`Indexer.layerWithDatabase` provides `Indexer`, `IndexerDatabase`, Effect's pretty console logger and, with `telemetry.otlp`, the metrics exporter from a single config. For advanced composition, use the granular building blocks: `Indexer.layer(options)` (requires `IndexerDatabase`), `IndexerDatabase.layer(config)` (opens the database and creates the indexer's tables), `IndexerDatabase.transaction`, `migrate({ migrationsFolder })` (applies your migrations), `loggerLayer`, `StacksClient` and `readOnly`. Interrupting the `live` fiber stops live sync. `indexer.status` reads the current [`IndexerStatus`](#indexerstatus).

---

## Time-Travel Read-Only Contract Calls

Inside your event handlers, you can perform read-only contract calls that are automatically pinned to the block of the event being processed, so they see the contract state as of that block. Both typed calls (using a Clarity ABI) and untyped calls are supported, and both return decoded Clarity values:

```ts
const handler = async (event, { client }) => {
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
};
```

Clarity-level failures (`okay: false`) reject with `ReadOnlyCallError`.

Pass `tip` to read at another block. It takes the block's index block hash (`index_block_hash` in the Stacks API), the only form the node pins reads to; `event.index_block_hash` holds the one of the event's block.

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
await using indexer = await createIndexer({
  database: { kind: "pglite", directory: "./indexer.db" },
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

With the Effect API, pass the same `telemetry` option to `Indexer.layerWithDatabase`, or compose Effect's exporter yourself next to `Indexer.layer`. Metrics live in Effect's default `MetricRegistry`, so any `OtlpMetrics` layer in the same runtime exports them:

```ts
import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpMetrics, OtlpSerialization } from "effect/observability";
import { Indexer, IndexerDatabase } from "stacksindex/effect";

const MetricsLive = OtlpMetrics.layer({
  url: "http://localhost:4318/v1/metrics",
  resource: { serviceName: "my-indexer" }, // required unless OTEL_SERVICE_NAME is set
}).pipe(Layer.provide(Layer.mergeAll(OtlpSerialization.layerProtobuf, FetchHttpClient.layer)));

const IndexerLive = Indexer.layer({ chain: "mainnet" }).pipe(
  Layer.provideMerge(IndexerDatabase.layer({ kind: "pglite", directory: "./indexer.db" })),
);

// The exporter flushes a last snapshot when `program` ends and the layers close.
await Effect.runPromise(program.pipe(Effect.provide(Layer.mergeAll(IndexerLive, MetricsLive))));
```

### Metrics

Every series carries a `chain_id` attribute (`"1"` for mainnet). Per-contract series carry `contract` with the contract ID. Effect's exporter sends each metric's unit as a `unit` attribute as well.

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

`indexer.status()` (`yield* indexer.status` with the Effect API) reports the indexer's phase and its stored progress. `ready` turns `true` once the historical pass finished (`phase` is `"live"` or `"done"`), which makes it a readiness probe for a service that runs `live`:

```ts
import { createServer } from "node:http";

createServer(async (_request, response) => {
  try {
    const status = await indexer.status();

    response.writeHead(status.ready ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify(status));
  } catch {
    response.writeHead(503).end();
  }
}).listen(8080);
```

See [`IndexerStatus`](#indexerstatus) for the fields. `status()` rejects with `SyncStoreError` while the indexer tables are missing or the database is unreachable.

### Troubleshooting

The exporter logs its target once at `Info` when the indexer starts. Failed exports are logged only at `Debug` (after which the exporter pauses for 60 seconds), so set `logLevel: "Debug"` when no metrics arrive.

---

## Configuration Reference

### `createIndexer(options)`

| Option                          | Type                                             | Default                          | Description                                                                                                                                    |
| ------------------------------- | ------------------------------------------------ | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `database`                      | `DatabaseConfig`                                 | _Required_                       | Indexer storage. `{ kind: "pglite", directory? }` or `{ kind: "postgres", connectionString }`.                                                 |
| `relations`                     | `Relations` from `defineRelations`               | `undefined`                      | Drizzle relations enabling typed `db.query` on `indexer.db` and `context.db`.                                                                  |
| `chain`                         | `"mainnet" \| "testnet" \| { id, apiUrl }`       | `"mainnet"`                      | `"mainnet"` (chain `1`), `"testnet"` (chain `2147483648`), or a custom chain ID with the API serving it (e.g. a devnet).                       |
| `finality`                      | `number`                                         | `6`                              | Depth, in blocks, of reorgs handled by replaying; deeper reorgs fail with `ReorgError`.                                                        |
| `api.url`                       | `string`                                         | _Chain default_                  | Stacks API URL (`"https://api.hiro.so"` for Mainnet, `"https://api.testnet.hiro.so"` for Testnet). Explicit value overrides the chain default. |
| `api.apiKey`                    | `string`                                         | `undefined`                      | Optional Hiro API key.                                                                                                                         |
| `live.transport`                | `"polling" \| "websocket"`                       | `"polling"`                      | How `live` detects new blocks.                                                                                                                 |
| `live.pollingInterval`          | `number`                                         | `5000`                           | Milliseconds between polls for the latest block (minimum `100`). Also used after a websocket falls back to polling.                            |
| `live.webSocketUrl`             | `string`                                         | `/extended/v1/ws` (API)          | Websocket endpoint; defaults to the API base URL with `wss:` (or `ws:`) and `/extended/v1/ws`.                                                 |
| `logLevel`                      | `LogLevel`                                       | `"Info"`                         | Minimum log level for the console logger.                                                                                                      |
| `telemetry.otlp.baseUrl`        | `string`                                         | _Required with `otlp`_           | OTLP/HTTP base URL; `/v1/metrics` is appended. Metrics are not exported without `telemetry.otlp`.                                              |
| `telemetry.otlp.headers`        | `Record<string, string>`                         | `undefined`                      | Headers sent with every export, e.g. authentication.                                                                                           |
| `telemetry.otlp.exportInterval` | `number`                                         | `10000`                          | Milliseconds between exports (positive integer).                                                                                               |
| `telemetry.otlp.temporality`    | `"cumulative" \| "delta"`                        | `"cumulative"`                   | `"cumulative"` for Prometheus, `"delta"` for Datadog or Dynatrace.                                                                             |
| `telemetry.otlp.resource`       | `{ serviceName?, serviceVersion?, attributes? }` | `{ serviceName: "stacksindex" }` | OpenTelemetry resource attached to every export.                                                                                               |

### `Indexer` (Promise)

| Member                  | Description                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `run(filters)`          | Syncs and indexes a single filter or an array up to the current chain tip; resolves with a `RunResult`.                                          |
| `live(filters)`         | Runs `run`, then follows new blocks. Resolves when every filter reached its `endBlock` or on `close()`; rejects on a fatal error.                |
| `db`                    | Database handle outside any batch, to query your tables (e.g. from an API) and the indexer's. On PGlite, queries wait for the batch in progress. |
| `migrate(options)`      | Applies your drizzle-kit migrations from `options.migrationsFolder`. The indexer's own tables are created by `createIndexer`.                    |
| `status()`              | Resolves with the current [`IndexerStatus`](#indexerstatus).                                                                                     |
| `close()`               | Stops live sync, flushes pending metrics and releases database and runtime resources. Safe to call multiple times.                               |
| `[Symbol.asyncDispose]` | Same as `close()`, enabling `await using`.                                                                                                       |

### Filter

| Property     | Type                 | Default                 | Description                                                      |
| ------------ | -------------------- | ----------------------- | ---------------------------------------------------------------- |
| `contractId` | `string`             | _Required_              | Fully qualified contract identifier (e.g. `SP...contract-name`). |
| `handler`    | `EventHandler`       | _Required_              | Function called for every matching smart contract event.         |
| `startBlock` | `number`             | `deployment block`      | Start indexing from this block height.                           |
| `endBlock`   | `number \| "latest"` | _All available history_ | Block height to stop at, or `"latest"`.                          |

### RunResult

| Property               | Type                  | Description                                                                   |
| ---------------------- | --------------------- | ----------------------------------------------------------------------------- |
| `eventsProcessed`      | `number`              | Total events passed to handlers during the run.                               |
| `contracts`            | `ContractRunResult[]` | Per-contract outcome: `status`, `lastBlockHeight`, event count.               |
| `finalizedBlockHeight` | `number \| undefined` | Highest finalized block after the run; `undefined` when no checkpoint exists. |

`status` is `"completed"` when the contract was synced during the run and `"up-to-date"` when it was already fully synced.

### IndexerStatus

| Property     | Type                                                       | Description                                                                                          |
| ------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `chainId`    | `number`                                                   | Chain the indexer runs on.                                                                           |
| `phase`      | `"idle" \| "backfill" \| "live" \| "done" \| "failed"`     | `idle` before any `run`/`live` or after an interruption; `failed` after the last call failed.        |
| `ready`      | `boolean`                                                  | `true` once the historical pass finished (`phase` is `"live"` or `"done"`).                          |
| `checkpoint` | `{ blockHeight, blockTime, finalizedBlockHeight } \| null` | Height through which every event has been indexed; `null` before the first batch. Survives restarts. |
| `anchor`     | `{ blockHeight } \| null`                                  | Chain tip read at the start of the latest pass.                                                      |
| `contracts`  | `{ contractId, syncedBlockHeight, isComplete }[]`          | Stored sync progress of every contract on the chain.                                                 |

`phase` is in memory and starts at `"idle"` in every new process; `checkpoint`, `anchor` and `contracts` are read from the indexer database.

---

## Examples

Check out [`examples/dex-alex`](./examples/dex-alex) for a complete working example indexing the ALEX DEX pool contracts with relational tables, typed read-only calls, and Zod validation using the promise API.

Check out [`examples/dex-alex-effect`](./examples/dex-alex-effect) for the same indexer written entirely with the Effect API (`Effect.gen`, `Schema`, scoped database resources).

---

## License

MIT © [Léo Pradel](https://github.com/pradel)
