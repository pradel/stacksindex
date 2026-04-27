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
  level: 5,
});

const runtime = createHistoricalRuntime({ logger, db: indexerDb });

const result = await runtime.run([
  {
    contractId: "SPGDS0Y17973EN5TCHNHGJJ9B31XWQ5YX8A36C9B.usdcx-poolv1",
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
