import fs from "node:fs";
import process from "node:process";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createHistoricalRuntime, createLogger, migrate as migrateIndexer } from "indexer";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";

const apiKey = process.env.HIRO_API_KEY;

fs.mkdirSync("./data", { recursive: true });

const appClient = new PGlite("./data/app.db");
const appDb = drizzle({ client: appClient });

await migrate(appDb, { migrationsFolder: "./drizzle" });

const indexerClient = new PGlite("./data/indexer.db");
const indexerDb = drizzle({ client: indexerClient });

await migrateIndexer(indexerDb);

const logger = createLogger({
  level: 2,
});

const runtime = createHistoricalRuntime({ logger, db: indexerDb, api: { apiKey } });

const result = await runtime.run([
  {
    contractId: POOL_CONTRACT,
    handler: createPoolHandler({ db: appDb, logger }),
  },
]);

if (result.isErr()) {
  logger.error({ msg: "Error running historical sync", error: result.error });
  process.exit(1);
}
