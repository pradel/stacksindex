import fs from "node:fs";
import process from "node:process";

import { pglite, type Indexer } from "stacksindex";

import { poolHandler, poolSnapshotsHandler } from "./handler.ts";
import { indexer } from "./indexer.ts";
import type { relations } from "./schema.ts";

const apiKey = process.env.HIRO_API_KEY;

// For example http://localhost:4318 (OpenTelemetry Collector) or http://localhost:9090/api/v1/otlp (Prometheus).
const otlpBaseUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

// `pnpm dev --live` keeps following new blocks after the historical sync.
const isLive = process.argv.includes("--live");

fs.mkdirSync("./data", { recursive: true });

let app: Indexer<typeof relations> | undefined;

let isShuttingDown = false;

async function shutdown(code: number) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await app?.close();
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
  /*
   * One database holds the indexer's tables (`stacksindex` schema) and the
   * app's tables (`public`, from the `./drizzle` migrations), so handler
   * writes commit with the checkpoint.
   */
  app = await indexer.create({
    database: pglite("./data/indexer.db"),
    migrations: "./drizzle",
    chain: "mainnet",
    api: { apiKey },
    live: { transport: process.env.STACKS_TRANSPORT === "websocket" ? "websocket" : "polling" },
    telemetry: otlpBaseUrl ? { otlp: { baseUrl: otlpBaseUrl } } : undefined,
    handlers: { pool: poolHandler, poolSnapshots: poolSnapshotsHandler },
  });

  await (isLive ? app.live() : app.run());

  await shutdown(0);
} catch (err) {
  // `close()` on SIGINT / SIGTERM interrupts `run()`, which then rejects.
  if (!isShuttingDown) {
    // oxlint-disable-next-line no-console
    console.error("Error running the indexer", err);
    await shutdown(1);
  }
}
