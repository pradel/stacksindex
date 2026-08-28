# stacksindex

## Getting Started

```ts
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { createHistoricalRuntime, createLogger } from "stacksindex";

const logger = createLogger({ level: 2 });
const db = drizzle({ client: new PGlite("./indexer.db") });

const runtime = createHistoricalRuntime({ logger, db });

await runtime.run([
  {
    contractId: "SP….my-contract",
    startBlock: 150_000, // optional: skip earlier events
    endBlock: 151_181, // optional: stop at this height
    async handler(event, context) {
      // Write derived rows to your own database (PGlite or Postgres)
      // await appDb.insert(myTable).values({ ... });
    },
  },
]);
```

## Development

- Check everything is ready:

```bash
vp run ready
```

- Run the tests:

```bash
pnpm test
```

- Build the monorepo:

```bash
pnpm build
```
