import fs from "node:fs";
import process from "node:process";

import { Cause, Effect, Exit, Fiber } from "effect";
import { Indexer, pglite } from "stacksindex/effect";

import { PoolHandler, PoolSnapshotsHandler } from "./handler.ts";
import { indexer } from "./indexer.ts";

const apiKey = process.env.HIRO_API_KEY;

// `pnpm dev --live` keeps following new blocks after the historical sync.
const isLive = process.argv.includes("--live");

fs.mkdirSync("./data", { recursive: true });

const program = Effect.gen(function* () {
  const app = yield* Indexer;

  yield* isLive ? app.live : app.run;
});

const fiber = Effect.runFork(
  program.pipe(
    Effect.provide(
      /*
       * One database holds the indexer's tables (`stacksindex` schema) and the
       * app's tables (`public`, from the `./drizzle` migrations), so handler
       * writes through `indexer.Db` commit with the checkpoint.
       */
      indexer.layer({
        database: pglite("./data/indexer.db"),
        migrations: "./drizzle",
        chain: "mainnet",
        api: { apiKey },
        live: { transport: process.env.STACKS_TRANSPORT === "websocket" ? "websocket" : "polling" },
        logLevel: "Info",
        handlers: { pool: PoolHandler, poolSnapshots: PoolSnapshotsHandler },
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
  Effect.runSync(Effect.logError("Error running the indexer", Cause.squash(exit.cause)));

  await shutdown(1);
} else {
  await shutdown(0);
}
