import fs from "node:fs";
import process from "node:process";

import { createIndexer, type Indexer } from "stacksindex";

import { createPoolHandler, POOL_CONTRACT } from "./handler.ts";
import { relations } from "./schema.ts";

const apiKey = process.env.HIRO_API_KEY;

// For example http://localhost:4318 (OpenTelemetry Collector) or http://localhost:9090/api/v1/otlp (Prometheus).
const otlpBaseUrl = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

fs.mkdirSync("./data", { recursive: true });

let indexer: Indexer<typeof relations> | undefined;

let isShuttingDown = false;

async function shutdown(code: number) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;

  try {
    await indexer?.close();
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

// `pnpm dev --live` keeps following new blocks after the historical sync.
const isLive = process.argv.includes("--live");

try {
  // One database holds the indexer's tables (`stacksindex` schema) and the
  // App's tables (`public`), so handler writes commit with the checkpoint.
  indexer = await createIndexer({
    database: { kind: "pglite", directory: "./data/indexer.db" },
    relations,
    chain: "mainnet",
    api: { apiKey },
    live: { transport: process.env.STACKS_TRANSPORT === "websocket" ? "websocket" : "polling" },
    telemetry: otlpBaseUrl ? { otlp: { baseUrl: otlpBaseUrl } } : undefined,
  });

  await indexer.migrate({ migrationsFolder: "./drizzle" });

  const filter = {
    contractId: POOL_CONTRACT,
    handler: createPoolHandler(),
  };

  await (isLive ? indexer.live(filter) : indexer.run(filter));

  await shutdown(0);
} catch (err) {
  const error = err instanceof Error ? err : new Error(String(err));

  // oxlint-disable-next-line no-console
  console.error("Error running the indexer", error);
  await shutdown(1);
}
