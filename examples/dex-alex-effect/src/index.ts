import fs from "node:fs";
import process from "node:process";

import { Cause, Effect, Exit, Fiber } from "effect";
import { HistoricalRuntime, loggerLayer, makeDatabase } from "stacksindex/effect";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";

const apiKey = process.env.HIRO_API_KEY;

const program = Effect.gen(function* () {
  yield* Effect.sync(() => {
    fs.mkdirSync("./data", { recursive: true });
  });

  const appDatabase = yield* makeDatabase({
    kind: "pglite",
    directory: "./data/app.db",
  });

  yield* appDatabase.migrate({ migrationsFolder: "./drizzle" });

  const runtime = yield* HistoricalRuntime;

  yield* runtime.run([
    {
      contractId: POOL_CONTRACT,
      handler: createPoolHandler({ db: appDatabase.db }),
    },
  ]);
});

const fiber = Effect.runFork(
  Effect.scoped(program).pipe(
    Effect.provide(
      HistoricalRuntime.layerWithDatabase({
        database: { kind: "pglite", directory: "./data/indexer.db" },
        network: "mainnet",
        api: { apiKey },
        logLevel: "Info",
      }),
    ),
  ),
);

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

  Effect.runSync(
    Effect.logError(
      "Error running historical sync",
      error instanceof Error ? error : new Error(String(error)),
    ).pipe(Effect.provide(loggerLayer({ level: "Info" }))),
  );

  await shutdown(1);
} else {
  await shutdown(0);
}
