import fs from "node:fs";
import process from "node:process";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createDatabase, createHistoricalRuntime, createLogger } from "indexer";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";

const apiKey = process.env.HIRO_API_KEY;

fs.mkdirSync("./data", { recursive: true });

const appClient = new PGlite("./data/app.db");
await appClient.waitReady;
const appDb = drizzle({ client: appClient });

await migrate(appDb, { migrationsFolder: "./drizzle" });

const indexerDatabase = await createDatabase({
  kind: "pglite",
  directory: "./data/indexer.db",
});

const logger = createLogger({
  level: 2,
});

let isShuttingDown = false;
async function shutdown(code: number) {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  try {
    await appClient.close();
  } catch {
    // Ignore error on close
  }
  try {
    await indexerDatabase.close();
  } catch {
    // Ignore error on close
  }
  process.exit(code);
}

process.on("SIGINT", () => {
  // oxlint-disable-next-line eslint/no-void
  void shutdown(0);
});
process.on("SIGTERM", () => {
  // oxlint-disable-next-line eslint/no-void
  void shutdown(0);
});

const runtime = createHistoricalRuntime({ logger, db: indexerDatabase.db, api: { apiKey } });

const result = await runtime.run([
  {
    contractId: POOL_CONTRACT,
    handler: createPoolHandler({ db: appDb, logger }),
  },
]);

if (result.isErr()) {
  logger.error({ msg: "Error running historical sync", error: result.error });
  await shutdown(1);
} else {
  await shutdown(0);
}
