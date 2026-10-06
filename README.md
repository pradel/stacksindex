# stacksindex

A simple, open-source historical indexer for the Stacks blockchain.

[![npm version](https://img.shields.io/npm/v/stacksindex.svg)](https://www.npmjs.com/package/stacksindex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`stacksindex` lets you backfill smart contract events, execute user-defined handlers to derive custom relational state, and query historical contract data at specific block heights.

Two entrypoints ship with the package:

- **`stacksindex`** — promise-native API for scripts, CLIs and Node services.
- **`stacksindex/effect`** — Effect-native services and layers.

---

## Features

- **Simple & Open-Source**: Focused on developer simplicity with zero unnecessary abstractions.
- **Reliable Historical Backfill**: Automatically discovers contract deployment blocks and initial event cursors to paginate backwards or forwards seamlessly.
- **Embedded or External Database**: First-class support for embedded [PGlite](https://pglite.electric-sql.com/) (zero configuration) or production PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/).
- **Time-Travel Read-Only Calls**: Query contract state (`client.callReadOnly`) automatically pinned to the exact block height of the event being processed.
- **Clarity Codec Built-in**: Easily decode raw Clarity hex values to plain JavaScript objects (`decodeHex`, `cvToJSON`).
- **Crash Recovery**: Checkpointing and resume progress stored directly in the database so sync resumes where it left off.

---

## Installation

```bash
pnpm add stacksindex @electric-sql/pglite drizzle-orm
```

_(or via `npm install` / `yarn add` / `bun add`)_

---

## Quickstart (Promise)

```ts
import { createHistoricalRuntime, decodeHex } from "stacksindex";

// 1. Create the runtime: it owns the indexer database and the Stacks API client
await using runtime = await createHistoricalRuntime({
  database: { kind: "pglite", directory: "./indexer.db" },
  network: "mainnet",
  api: {
    apiKey: process.env.HIRO_API_KEY, // Optional: Stacks / Hiro API key for higher rate limits
  },
  logLevel: "Info",
});

// 2. Run historical sync for one or more contracts
const result = await runtime.run({
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

`createHistoricalRuntime` owns the database lifecycle. Call `runtime.close()` (or use `await using` as above) to release resources. Pass an array of filters to `run` to index multiple contracts in one pass.

---

## Effect API

The same indexer can be composed entirely with Effect services and layers from `stacksindex/effect`:

```ts
import { Effect } from "effect";
import { HistoricalRuntime } from "stacksindex/effect";

const apiKey = process.env.HIRO_API_KEY;

const program = Effect.gen(function* () {
  const runtime = yield* HistoricalRuntime;

  yield* runtime.run([
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
      HistoricalRuntime.layerWithDatabase({
        database: { kind: "pglite", directory: "./indexer.db" },
        network: "mainnet",
        api: { apiKey },
        logLevel: "Info",
      }),
    ),
  ),
);
```

`HistoricalRuntime.layerWithDatabase` provides `HistoricalRuntime`, `IndexerDatabase` and Effect's pretty console logger from a single config. For advanced composition, use the granular building blocks: `HistoricalRuntime.layer(options)` (requires `IndexerDatabase`), `IndexerDatabase.layer(config)`, `IndexerDatabase.transaction`, `makeDatabase`, `migrate`, `loggerLayer`, `StacksClient` and `readOnly`.

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

## Configuration Reference

### `createHistoricalRuntime(options)`

| Option        | Type                               | Default           | Description                                                                                                                                      |
| ------------- | ---------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `database`    | `DatabaseConfig`                   | _Required_        | Indexer storage. `{ kind: "pglite", directory? }` or `{ kind: "postgres", connectionString }`.                                                   |
| `network`     | `"mainnet" \| "testnet" \| number` | `"mainnet"`       | `"mainnet"` (chain `1`), `"testnet"` (chain `2147483648`), or a custom chain ID.                                                                 |
| `api.baseUrl` | `string`                           | _Network default_ | Stacks API URL (`"https://api.hiro.so"` for Mainnet, `"https://api.testnet.hiro.so"` for Testnet). Explicit value overrides the network default. |
| `api.apiKey`  | `string`                           | `undefined`       | Optional Hiro API key.                                                                                                                           |
| `logLevel`    | `LogLevel`                         | `"Info"`          | Minimum log level for the console logger.                                                                                                        |

### `HistoricalRuntime` (Promise)

| Member                  | Description                                                                        |
| ----------------------- | ---------------------------------------------------------------------------------- |
| `run(filters)`          | Runs historical sync for a single filter or an array; resolves with a `RunResult`. |
| `db`                    | Indexer database handle for inspecting sync progress and cached data.              |
| `migrate(options?)`     | Applies pending migrations to the indexer database.                                |
| `close()`               | Releases database and runtime resources. Safe to call multiple times.              |
| `[Symbol.asyncDispose]` | Same as `close()`, enabling `await using`.                                         |

### Filter

| Property     | Type                 | Default                 | Description                                                      |
| ------------ | -------------------- | ----------------------- | ---------------------------------------------------------------- |
| `contractId` | `string`             | _Required_              | Fully qualified contract identifier (e.g. `SP...contract-name`). |
| `handler`    | `EventHandler`       | _Required_              | Function called for every matching smart contract event.         |
| `startBlock` | `number`             | `deployment block`      | Start indexing from this block height.                           |
| `endBlock`   | `number \| "latest"` | _All available history_ | Block height to stop at, or `"latest"`.                          |

### RunResult

| Property          | Type                  | Description                                                     |
| ----------------- | --------------------- | --------------------------------------------------------------- |
| `eventsProcessed` | `number`              | Total events passed to handlers during the run.                 |
| `contracts`       | `ContractRunResult[]` | Per-contract outcome: `status`, `lastBlockHeight`, event count. |

`status` is `"completed"` when the contract was synced during the run and `"up-to-date"` when it was already fully synced.

---

## Examples

Check out [`examples/dex-alex`](./examples/dex-alex) for a complete working example indexing the ALEX DEX pool contracts with relational tables, typed read-only calls, and Zod validation using the promise API.

Check out [`examples/dex-alex-effect`](./examples/dex-alex-effect) for the same indexer written entirely with the Effect API (`Effect.gen`, `Schema`, scoped database resources).

---

## License

MIT © [Léo Pradel](https://github.com/pradel)
