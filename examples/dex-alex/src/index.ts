import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createHistoricalRuntime, createLogger, migrate as migrateIndexer } from "indexer";

const appClient = new PGlite("./data/app.db");
const appDb = drizzle({ client: appClient });

await migrate(appDb, { migrationsFolder: "./drizzle" });

const indexerClient = new PGlite("./data/indexer.db");
const indexerDb = drizzle({ client: indexerClient });

await migrateIndexer(indexerDb);

const logger = createLogger({
  level: 2,
});

const runtime = createHistoricalRuntime({ logger, db: indexerDb });

const result = await runtime.run([
  {
    contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01",
    handler: (event, { db: _db }) => {
      logger.info({ msg: "Handler called", event });
      return Promise.resolve();
    },
  },
]);

if (result.isErr()) {
  logger.error({ msg: "Error running historical sync", error: result.error });
  // oxlint-disable-next-line no-undef
  process.exit(1);
}
