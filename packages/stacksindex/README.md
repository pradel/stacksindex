# stacksindex

A simple, open-source indexer for the Stacks blockchain: historical backfill, then live sync of new blocks.

[![npm version](https://img.shields.io/npm/v/stacksindex.svg)](https://www.npmjs.com/package/stacksindex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`stacksindex` lets you backfill smart contract events, follow new blocks as they are mined, execute user-defined handlers to derive custom relational state, and query historical contract data at specific block heights.

Two entrypoints ship with the package:

- **`stacksindex`** — promise-native API for scripts, CLIs and Node services.
- **`stacksindex/effect`** — Effect-native services and layers.

---

## Features

- **Simple & Open-Source**: Focused on developer simplicity with zero unnecessary abstractions.
- **Reliable Historical Backfill**: Automatically discovers contract deployment blocks and initial event cursors to paginate backwards or forwards seamlessly.
- **Live Sync**: After the backfill, follow new blocks by polling the API or over its websocket, fetching each block's events or each contract's newest logs, whichever costs fewer requests.
- **Embedded or External Database**: First-class support for embedded [PGlite](https://pglite.electric-sql.com/) (zero configuration) or production PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/).
- **Time-Travel Read-Only Calls**: Query contract state (`client.callReadOnly`) automatically pinned to the exact block height of the event being processed.
- **Clarity Codec Built-in**: Easily decode raw Clarity hex values to plain JavaScript objects (`decodeHex`, `cvToJSON`).
- **Crash Recovery**: Checkpointing and resume progress stored directly in the database so sync resumes where it left off. Unfinalized data is replayed after a restart, so reorgs are handled automatically.

---

## Installation

```bash
pnpm add stacksindex @electric-sql/pglite drizzle-orm
```

_(or via `npm install` / `yarn add` / `bun add`)_

---

## Quickstart (Promise)

```ts
import { createIndexer, decodeHex } from "stacksindex";

// 1. Create the indexer: it owns the indexer database and the Stacks API client
await using indexer = await createIndexer({
  database: { kind: "pglite", directory: "./indexer.db" },
  network: "mainnet",
  api: {
    apiKey: process.env.HIRO_API_KEY, // Optional: Stacks / Hiro API key for higher rate limits
  },
  logLevel: "Info",
});

// 2. Sync and index one or more contracts up to the current chain tip
const result = await indexer.run({
  contractId: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles",
  startBlock: 47784, // optional: start indexing from this block height
  endBlock: "latest", // optional: stop at a specific height or 'latest'
  async handler(event, { logger }) {
    // Decode Clarity event data
    const data = decodeHex(event.contract_log.value.hex);

    logger.info("Received event", {
      block: event.block_height,
      txId: event.tx_id,
    });

    // Write to your application database tables:
    // await appDb.insert(myTable).values({ ... });
  },
});

console.log(`Indexed ${result.eventsProcessed} events`);
```

`createIndexer` owns the database lifecycle. Call `indexer.close()` (or use `await using` as above) to release resources. Pass an array of filters to `run` to index multiple contracts in one pass.

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
import { Indexer } from "stacksindex/effect";

const apiKey = process.env.HIRO_API_KEY;

const program = Effect.gen(function* () {
  const indexer = yield* Indexer;

  // `indexer.live(filters)` follows new blocks after the historical pass.
  yield* indexer.run([
    {
      contractId: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles",
      handler: (event) =>
        Effect.logInfo("Received event").pipe(
          Effect.annotateLogs({ block: event.block_height, txId: event.tx_id }),
        ),
    },
  ]);
});

await Effect.runPromise(
  program.pipe(
    Effect.provide(
      Indexer.layerWithDatabase({
        database: { kind: "pglite", directory: "./indexer.db" },
        network: "mainnet",
        api: { apiKey },
        logLevel: "Info",
      }),
    ),
  ),
);
```

`Indexer.layerWithDatabase` provides `Indexer`, `IndexerDatabase` and Effect's pretty console logger from a single config. For advanced composition, use the granular building blocks: `Indexer.layer(options)` (requires `IndexerDatabase`), `IndexerDatabase.layer(config)`, `IndexerDatabase.transaction`, `makeDatabase`, `migrate`, `loggerLayer`, `StacksClient` and `readOnly`. Interrupting the `live` fiber stops live sync.

---

## Time-Travel Read-Only Contract Calls

Inside your event handlers, you can perform read-only contract calls that are automatically pinned to the event's `block_height`. Both typed calls (using a Clarity ABI) and untyped calls are supported, and both return decoded Clarity values:

```ts
const handler = async (event, { client }) => {
  // Pinned read-only contract call (automatically passes tip: event.block_height)
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

---

## Crash Recovery & Reorgs

Checkpoints and per-contract sync progress live in the indexer database, so `run` and `live` resume where they left off.

Re-running on a schedule is cheap: a contract that is already synced costs a single request to the newest page of its logs, plus two requests per run (the chain tip and the reorg check). Events mined while a run is in progress are indexed by the next run, so handlers always see events in chain order.

Every run, and every new head in live sync, checks for reorgs: it compares the hash of the chain tip saved by the previous pass with the canonical chain. When a reorg replaced stored blocks, the indexer rewinds to the newest stored block that is still canonical, refetches from there and replays the range through your handlers. Without a reorg nothing is replayed.

Set `finality` to the deepest reorg you want handled automatically (default `6`). A reorg that replaces a block at or below `finalizedBlockHeight` fails with `ReorgError` instead of silently changing data reported as final; re-sync from an empty indexer database to recover. With `finality: 0`, any reorg that reaches indexed blocks fails this way.

Handler writes are **not** rolled back when a range is replayed. Write idempotent handlers (upsert by primary key, or delete-then-insert) so re-executing an event produces the same final state. Writes for events that disappear in a reorg are not undone.

## Configuration Reference

### `createIndexer(options)`

| Option                 | Type                               | Default                 | Description                                                                                                                                      |
| ---------------------- | ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database`             | `DatabaseConfig`                   | _Required_              | Indexer storage. `{ kind: "pglite", directory? }` or `{ kind: "postgres", connectionString }`.                                                   |
| `network`              | `"mainnet" \| "testnet" \| number` | `"mainnet"`             | `"mainnet"` (chain `1`), `"testnet"` (chain `2147483648`), or a custom chain ID.                                                                 |
| `finality`             | `number`                           | `6`                     | Depth, in blocks, of reorgs handled by replaying; deeper reorgs fail with `ReorgError`.                                                          |
| `api.baseUrl`          | `string`                           | _Network default_       | Stacks API URL (`"https://api.hiro.so"` for Mainnet, `"https://api.testnet.hiro.so"` for Testnet). Explicit value overrides the network default. |
| `api.apiKey`           | `string`                           | `undefined`             | Optional Hiro API key.                                                                                                                           |
| `live.transport`       | `"polling" \| "websocket"`         | `"polling"`             | How `live` detects new blocks.                                                                                                                   |
| `live.pollingInterval` | `number`                           | `5000`                  | Milliseconds between polls for the latest block (minimum `100`). Also used after a websocket falls back to polling.                              |
| `live.webSocketUrl`    | `string`                           | `/extended/v1/ws` (API) | Websocket endpoint; defaults to the API base URL with `wss:` (or `ws:`) and `/extended/v1/ws`.                                                   |
| `logLevel`             | `LogLevel`                         | `"Info"`                | Minimum log level for the console logger.                                                                                                        |

### `Indexer` (Promise)

| Member                  | Description                                                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `run(filters)`          | Syncs and indexes a single filter or an array up to the current chain tip; resolves with a `RunResult`.                           |
| `live(filters)`         | Runs `run`, then follows new blocks. Resolves when every filter reached its `endBlock` or on `close()`; rejects on a fatal error. |
| `db`                    | Indexer database handle for inspecting sync progress and cached data.                                                             |
| `migrate(options?)`     | Applies pending migrations to the indexer database.                                                                               |
| `close()`               | Stops live sync and releases database and runtime resources. Safe to call multiple times.                                         |
| `[Symbol.asyncDispose]` | Same as `close()`, enabling `await using`.                                                                                        |

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

---

## Examples

Check out [`examples/dex-alex`](./examples/dex-alex) for a complete working example indexing the ALEX DEX pool contracts with relational tables, typed read-only calls, and Zod validation using the promise API.

Check out [`examples/dex-alex-effect`](./examples/dex-alex-effect) for the same indexer written entirely with the Effect API (`Effect.gen`, `Schema`, scoped database resources).

---

## License

MIT © [Léo Pradel](https://github.com/pradel)
