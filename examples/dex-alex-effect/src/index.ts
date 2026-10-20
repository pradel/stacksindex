import fs from "node:fs";
import process from "node:process";

import { Cause, Effect, Exit, Fiber } from "effect";
import { Indexer, loggerLayer, migrate } from "stacksindex/effect";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";
import { relations } from "./schema.ts";

const apiKey = process.env.HIRO_API_KEY;

// `pnpm dev --live` keeps following new blocks after the historical sync.
const isLive = process.argv.includes("--live");

fs.mkdirSync("./data", { recursive: true });

const program = Effect.gen(function* () {
  // The app's tables live in `public`, next to the indexer's `stacksindex` schema.
  yield* migrate({ migrationsFolder: "./drizzle" });

  const indexer = yield* Indexer;

  const filters = [
    {
      contractId: POOL_CONTRACT,
      handler: createPoolHandler(),
    },
  ];

  yield* isLive ? indexer.live(filters) : indexer.run(filters);
});

const fiber = Effect.runFork(
  program.pipe(
    Effect.provide(
      // One database for the indexer and the app, so handler writes through
      // `context.db` commit with the checkpoint.
      Indexer.layerWithDatabase({
        database: { kind: "pglite", directory: "./data/indexer.db" },
        relations,
        network: "mainnet",
        api: { apiKey },
        live: { transport: process.env.STACKS_TRANSPORT === "websocket" ? "websocket" : "polling" },
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
      "Error running the indexer",
      error instanceof Error ? error : new Error(String(error)),
    ).pipe(Effect.provide(loggerLayer({ level: "Info" }))),
  );

  await shutdown(1);
} else {
  await shutdown(0);
}
