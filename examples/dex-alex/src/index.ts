import fs from "node:fs";
import process from "node:process";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { createHistoricalRuntime, type HistoricalRuntime } from "stacksindex";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";

const apiKey = process.env.HIRO_API_KEY;

fs.mkdirSync("./data", { recursive: true });

const appClient = new PGlite("./data/app.db");

await appClient.waitReady;

const appDb = drizzle({ client: appClient });

await migrate(appDb, { migrationsFolder: "./drizzle" });

let runtime: HistoricalRuntime | undefined;

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
    await runtime?.close();
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

try {
  runtime = await createHistoricalRuntime({
    database: { kind: "pglite", directory: "./data/indexer.db" },
    network: "mainnet",
    api: { apiKey },
  });

  await runtime.run({
    contractId: POOL_CONTRACT,
    handler: createPoolHandler({ db: appDb }),
  });

  await shutdown(0);
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));

  // oxlint-disable-next-line no-console
  console.error("Error running historical sync", error);
  await shutdown(1);
}
