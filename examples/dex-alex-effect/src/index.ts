import fs from "node:fs";
import process from "node:process";

import { Cause, Effect, Exit, Fiber } from "effect";
import { createHistoricalRuntime, createLogger, makeDatabase } from "stacksindex";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";

const apiKey = process.env.HIRO_API_KEY;

const logger = createLogger({
  level: 2,
});

const program = Effect.gen(function* () {
  yield* Effect.sync(() => {
    fs.mkdirSync("./data", { recursive: true });
  });

  const appDatabase = yield* makeDatabase({
    kind: "pglite",
    directory: "./data/app.db",
  });

  yield* appDatabase.migrate({ migrationsFolder: "./drizzle" });

  const indexerDatabase = yield* makeDatabase({
    kind: "pglite",
    directory: "./data/indexer.db",
  });

  const runtime = createHistoricalRuntime({
    logger,
    db: indexerDatabase.db,
    network: "mainnet",
    api: { apiKey },
  });

  yield* runtime.run([
    {
      contractId: POOL_CONTRACT,
      handler: createPoolHandler({ db: appDatabase.db, logger }),
    },
  ]);
});

const fiber = Effect.runFork(Effect.scoped(program));

let isShuttingDown = false;

async function shutdown(code: number) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  await Effect.runPromise(Fiber.interrupt(fiber));
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

const exit = await Effect.runPromise(Fiber.await(fiber));

if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
  const error = Cause.squash(exit.cause);

  logger.error({
    msg: "Error running historical sync",
    error: error instanceof Error ? error : new Error(String(error)),
  });

  await shutdown(1);
} else {
  await shutdown(0);
}
