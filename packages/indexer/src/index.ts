import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

import { createLogger } from "./logger/index.ts";
import { createHistoricalRuntime } from "./runtime/historical.ts";

const client = new PGlite("./data/indexer.db");
const db = drizzle({ client });

await migrate(db, { migrationsFolder: "drizzle" });

const logger = createLogger({
  level: 5,
});

const runtime = createHistoricalRuntime({ logger, db });

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
