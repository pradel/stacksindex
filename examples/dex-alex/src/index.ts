import { mkdirSync } from "node:fs";
import { env } from "node:process";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as migrateApp } from "drizzle-orm/pglite/migrator";
import {
  createHistoricalRuntime,
  createLogger,
  migrate as migrateIndexer,
  parseCursor,
  syncStore,
  type HistoricalRuntimeContext,
} from "stacksindex";

import { POOL_CONTRACT, createAlexHandler } from "./handler.ts";

function optionalNumberEnv(name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Seed a resume cursor so operators (and the E2E acceptance run) can start
 * syncing from a known position instead of walking a contract's full history —
 * the Hiro address-transactions endpoint can time out on very large contracts.
 */
async function seedProgress(db: HistoricalRuntimeContext["db"], cursor: string): Promise<void> {
  // Validate the cursor format via parseCursor before seeding.
  const { blockHeight } = parseCursor(cursor);
  await syncStore.upsertSyncProgress(
    { contractId: POOL_CONTRACT, chainId: 1, cursor, lastBlockHeight: blockHeight },
    { db },
  );
}

async function main(): Promise<void> {
  const logger = createLogger({ level: 2 });
  const apiKey = env.HIRO_API_KEY;

  // PGlite does not create parent directories.
  mkdirSync("./data", { recursive: true });

  const appClient = new PGlite("./data/app.db");
  const appDb = drizzle({ client: appClient });
  await migrateApp(appDb, { migrationsFolder: "./drizzle" });

  const indexerClient = new PGlite("./data/indexer.db");
  const indexerDb = drizzle({ client: indexerClient });
  // The runtime auto-migrates too; run it eagerly so the seed below operates
  // On an up-to-date sync-store schema.
  await migrateIndexer(indexerDb);

  const seedCursor = env.SEED_CURSOR;
  if (seedCursor !== undefined && seedCursor !== "") {
    try {
      await seedProgress(indexerDb, seedCursor);
      logger.info({ msg: "Seeded sync progress", cursor: seedCursor });
    } catch (error) {
      logger.error({ msg: "Invalid SEED_CURSOR", cursor: seedCursor, error });
      // oxlint-disable-next-line no-undef
      process.exitCode = 1;
      await indexerClient.close();
      await appClient.close();
      return;
    }
  }

  const runtimeOptions: HistoricalRuntimeContext = {
    logger,
    db: indexerDb,
    network: "mainnet",
  };
  if (apiKey !== undefined) {
    runtimeOptions.apiKey = apiKey;
    logger.info({ msg: "Using Hiro API key from environment" });
  }

  const startBlock = optionalNumberEnv("START_BLOCK");
  const endBlock = optionalNumberEnv("END_BLOCK");

  const runtime = createHistoricalRuntime(runtimeOptions);

  const result = await runtime.run([
    {
      contractId: POOL_CONTRACT,
      handler: createAlexHandler({ appDb, logger }),
      startBlock,
      endBlock,
    },
  ]);

  if (result.isErr()) {
    logger.error({ msg: "Historical sync failed", error: result.error });
    // oxlint-disable-next-line no-undef
    process.exitCode = 1;
  }

  await indexerClient.close();
  await appClient.close();
}

if (env.NODE_ENV !== "test") {
  await main();
}
