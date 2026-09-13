import fs from "node:fs";
import process from "node:process";

import { createDatabase, createHistoricalRuntimePromise, createLogger } from "stacksindex";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";

const apiKey = process.env.HIRO_API_KEY;

fs.mkdirSync("./data", { recursive: true });

const appDatabase = await createDatabase({
  kind: "pglite",
  directory: "./data/app.db",
});
await appDatabase.migrate({ migrationsFolder: "./drizzle" });

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
    await appDatabase.close();
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

const runtime = createHistoricalRuntimePromise({
  logger,
  db: indexerDatabase.db,
  network: "mainnet",
  api: { apiKey },
});

try {
  await runtime.run([
    {
      contractId: POOL_CONTRACT,
      handler: createPoolHandler({ db: appDatabase.db, logger }),
    },
  ]);
  await shutdown(0);
} catch (err) {
  logger.error({ msg: "Error running historical sync", error: err });
  await shutdown(1);
}
