# stacksindex

A simple, open-source historical indexer for the Stacks blockchain.

[![npm version](https://img.shields.io/npm/v/stacksindex.svg)](https://www.npmjs.com/package/stacksindex)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

`stacksindex` lets you backfill smart contract events, execute user-defined handlers to derive custom relational state, and query historical contract data at specific block heights.

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

## Quickstart

```ts
import { createDatabase, createHistoricalRuntime, createLogger, decodeHex } from "stacksindex";

// 1. Setup logger and internal indexer database (stores sync checkpoints and cache)
const logger = createLogger({ level: 2 });
const indexerDatabase = await createDatabase({
  kind: "pglite",
  directory: "./indexer.db",
});

// 2. Initialize runtime
const runtime = createHistoricalRuntime({
  logger,
  db: indexerDatabase.db,
  api: {
    apiKey: process.env.HIRO_API_KEY, // Optional: Stacks / Hiro API key for higher rate limits
  },
});

// 3. Run historical sync for one or more contracts
const result = await runtime.run([
  {
    contractId: "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles",
    startBlock: 47784, // optional: start indexing from this block height
    endBlock: "latest", // optional: stop at a specific height or 'latest'
    async handler(event, context) {
      // Decode Clarity event data
      const data = decodeHex(event.contract_log.value.hex);

      logger.info({
        msg: "Received event",
        block: event.block_height,
        txId: event.tx_id,
        data,
      });

      // Write to your application database tables:
      // await appDb.insert(myTable).values({ ... });
    },
  },
]);

if (result.isErr()) {
  logger.error({ msg: "Historical sync failed", error: result.error });
}
```

---

## Time-Travel Read-Only Contract Calls

Inside your event handlers, you can perform read-only contract calls that are automatically pinned to the event's `block_height`. Both typed calls (using a Clarity ABI) and untyped calls are supported:

```ts
const handler = async (event, { client }) => {
  // Pinned read-only contract call (automatically passes tip: event.block_height)
  const countResult = await client.callReadOnly({
    abi: myContractAbi,
    contractAddress: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
    contractName: "my-token",
    functionName: "get-total-supply",
  });

  if (countResult.isOk()) {
    const totalSupply = countResult.value.ok;
    // ...
  }
};
```

---

## Configuration Reference

### `createHistoricalRuntime(context)`

| Option        | Type                               | Default                 | Description                                                  |
| ------------- | ---------------------------------- | ----------------------- | ------------------------------------------------------------ |
| `db`          | `NodePgDatabase \| PgliteDatabase` | _Required_              | Drizzle database instance for sync storage and checkpoints.  |
| `logger`      | `Logger`                           | _Required_              | Logger instance from `createLogger({ level })`.              |
| `chainId`     | `number`                           | `1`                     | Stacks Chain ID (`1` for Mainnet, `2147483648` for Testnet). |
| `api.baseUrl` | `string`                           | `"https://api.hiro.so"` | Stacks API URL.                                              |
| `api.apiKey`  | `string`                           | `undefined`             | Optional Hiro API key.                                       |

### Filter

| Property     | Type                 | Default                 | Description                                                      |
| ------------ | -------------------- | ----------------------- | ---------------------------------------------------------------- |
| `contractId` | `string`             | _Required_              | Fully qualified contract identifier (e.g. `SP...contract-name`). |
| `handler`    | `EventHandler`       | _Required_              | Async function called for every matching smart contract event.   |
| `startBlock` | `number`             | `deployment block`      | Start indexing from this block height.                           |
| `endBlock`   | `number \| "latest"` | _All available history_ | Block height to stop at, or `"latest"`.                          |

---

## Examples

Check out [`examples/dex-alex`](./examples/dex-alex) for a complete working example indexing the ALEX DEX pool contracts with relational tables and typed read-only calls.

---

## v0.1.0 Feedback & Roadmap

This **v0.1.0** release is an initial preview focused on **historical sync** and validating developer ergonomics, storage efficiency, and handler design.

- **Upcoming in v0.2.0**: Realtime block polling and live event streaming.
- **We want your feedback!**: Have thoughts on the handler API, data decoding, or performance? Please open an issue or start a discussion on the [GitHub repository](https://github.com/pradel/stacksindex/issues).

---

## License

MIT © [Léo Pradel](https://github.com/pradel)
