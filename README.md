# stacksindex

A lightweight indexer for Stacks smart contract events. Sync a contract's
historical `smart_contract_log` events from the Hiro API, decode the Clarity
values for you, and let your handlers build derived tables on top — a
simplified take on [Ponder](https://github.com/ponder-sh/ponder)'s
architecture, purpose-built for Stacks.

## Packages

| Package                                          | Description                                    |
| ------------------------------------------------ | ---------------------------------------------- |
| [`packages/stacksindex`](./packages/stacksindex) | Core indexing engine (sync + event processing) |
| [`examples/dex-alex`](./examples/dex-alex)       | Example indexer for the ALEX fixed-weight pool |

## Quickstart

```bash
pnpm install

# Run the ALEX example against mainnet (optional API key avoids rate limits)
echo "HIRO_API_KEY=your-key" > examples/dex-alex/.env
cd examples/dex-alex && pnpm dev
```

The example seeds a recent sync cursor, fetches the pool contract's print
events, decodes them, and populates `data/app.db` with `pool`, `token` and
`swap` tables. Inspect them with drizzle-kit:

```bash
cd examples/dex-alex && pnpm studio
```

To start from a specific position instead of seeding manually, export
`SEED_CURSOR` (`block:micro:tx:event`), `START_BLOCK` or `END_BLOCK`.

## Writing your own indexer

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createHistoricalRuntime, createLogger, decodeClarityValueUnwrapped } from "stacksindex";

const logger = createLogger({ level: 2 });
const db = drizzle({ client: new PGlite("./indexer.db") });

const runtime = createHistoricalRuntime({ logger, db, network: "mainnet" });

await runtime.run([
  {
    contractId: "SP….my-pool",
    startBlock: 150_000, // optional: skip earlier events
    endBlock: 151_181, // optional: stop at this height
    async handler(event, context) {
      // event.decoded is the parsed Clarity tuple (undefined if undecodable)
      const action = event.decoded?.type_id === 12 ? event.decoded.data.action?.data : undefined;

      // Read-only contract calls are available via context.client
      await context.client.callReadOnly("SP….my-token", "get-decimals");

      // Write derived rows to your own database (PGlite or node-postgres)
      // await appDb.insert(myTable).values({ ... });
    },
  },
]);
```

See [`packages/stacksindex/README.md`](./packages/stacksindex/README.md) for
the full API reference and [`docs/architecture.md`](./docs/architecture.md)
for how the engine works.

## Development

This repository uses [Vite+](https://viteplus.dev):

```bash
vp install        # install dependencies
vp check          # format + lint + typecheck
vp run -r test    # run all workspace tests
vp run -r build   # build all packages
vp run ready      # all of the above
```
