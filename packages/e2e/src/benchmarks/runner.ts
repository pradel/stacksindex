import { performance } from "node:perf_hooks";

import { createHistoricalRuntime, createLogger, type EventHandler } from "indexer";

import { RequestProfiler, type RequestMetrics } from "../profiler.ts";
import { createTestDatabase } from "../test-db.ts";
import { createTraceCollector } from "../tracer.ts";
import { generateMockDataset, type MockContractOptions } from "./generator.ts";

export interface BenchmarkResult {
  name: string;
  totalEvents: number;
  totalTransactions: number;
  totalBlocks: number;
  durationMs: number;
  throughputEventsPerSec: number;
  throughputTxsPerSec: number;
  requestMetrics: RequestMetrics;
  requestsPer100Events: number;
}

export interface ScenarioBenchmarkConfig {
  name: string;
  contractIds: string[];
  mockRequestFn: (handler: (url: string) => Promise<unknown>) => void;
  requestHandler: (rawUrl: string, init?: unknown) => Promise<unknown>;
  latencyMs?: number;
  startBlock?: number;
  endBlock?: number;
}

export interface SyntheticBenchmarkConfig {
  name: string;
  contracts: MockContractOptions[];
  mockRequestFn: (handler: (url: string) => Promise<unknown>) => void;
  latencyMs?: number;
}

export function formatBenchmarkTable(results: BenchmarkResult[]): string {
  const lines: string[] = [];
  lines.push("=".repeat(88));
  lines.push("                    HISTORICAL SYNC BENCHMARK RESULTS                    ");
  lines.push("=".repeat(88));

  for (const res of results) {
    lines.push(`Scenario: ${res.name}`);
    lines.push(
      `  Events: ${res.totalEvents} | Txs: ${res.totalTransactions} | Blocks: ${res.totalBlocks}`,
    );
    lines.push(
      `  Duration: ${res.durationMs.toFixed(0)} ms | Throughput: ${res.throughputEventsPerSec.toFixed(1)} ev/s (${res.throughputTxsPerSec.toFixed(1)} tx/s)`,
    );
    lines.push(`  Reqs / 100 Events: ${res.requestsPer100Events.toFixed(1)} reqs`);
    lines.push("  API Requests Breakdown:");
    lines.push(`    - Contract Metadata:      ${res.requestMetrics.contractMetadata}`);
    lines.push(`    - Principal Transactions: ${res.requestMetrics.principalTransactions}`);
    lines.push(`    - Transaction Details:    ${res.requestMetrics.transactionDetails}`);
    lines.push(`    - Batch Transactions:     ${res.requestMetrics.transactionMultiple}`);
    lines.push(`    - Transaction Events:     ${res.requestMetrics.transactionEvents}`);
    lines.push(`    - Contract Logs:          ${res.requestMetrics.contractLogs}`);
    lines.push(`    - Block Queries:          ${res.requestMetrics.blocks}`);
    lines.push(`    - Total HTTP Requests:    ${res.requestMetrics.total}`);
    lines.push("-".repeat(88));
  }

  return lines.join("\n");
}

export async function runScenarioBenchmark(
  config: ScenarioBenchmarkConfig,
): Promise<BenchmarkResult> {
  const profiler = new RequestProfiler({ latencyMs: config.latencyMs });
  config.mockRequestFn(profiler.wrapHandler(config.requestHandler));

  const testDb = await createTestDatabase();
  const logger = createLogger({ level: 0 });
  const runtime = createHistoricalRuntime({ logger, db: testDb.db });
  const tracer = createTraceCollector();

  const filters = config.contractIds.map((contractId) => {
    const handler: EventHandler = (event) => {
      tracer.record(contractId, event);
      return Promise.resolve();
    };
    return {
      contractId,
      handler,
      ...(config.startBlock === undefined ? {} : { startBlock: config.startBlock }),
      ...(config.endBlock === undefined ? {} : { endBlock: config.endBlock }),
    };
  });

  const startTime = performance.now();
  const result = await runtime.run(filters);
  const endTime = performance.now();
  const durationMs = endTime - startTime;

  await testDb.close();

  if (result.isErr()) {
    throw new Error(`Benchmark scenario failed: ${JSON.stringify(result.error)}`);
  }

  tracer.assertChronologicalOrder();
  const recordedEvents = tracer.getEvents();
  const totalEvents = recordedEvents.length;

  const uniqueTxIds = new Set(recordedEvents.map((item) => item.txId));
  const uniqueBlocks = new Set(recordedEvents.map((item) => item.blockHeight));

  const durationSeconds = durationMs / 1000;
  const throughputEventsPerSec = durationSeconds > 0 ? totalEvents / durationSeconds : 0;
  const throughputTxsPerSec = durationSeconds > 0 ? uniqueTxIds.size / durationSeconds : 0;
  const requestsPer100Events =
    totalEvents > 0 ? (profiler.metrics.total / totalEvents) * 100 : profiler.metrics.total;

  return {
    name: config.name,
    totalEvents,
    totalTransactions: uniqueTxIds.size,
    totalBlocks: uniqueBlocks.size,
    durationMs,
    throughputEventsPerSec: Math.round(throughputEventsPerSec * 10) / 10,
    throughputTxsPerSec: Math.round(throughputTxsPerSec * 10) / 10,
    requestMetrics: { ...profiler.metrics },
    requestsPer100Events: Math.round(requestsPer100Events * 10) / 10,
  };
}

export async function runSyntheticBenchmark(
  config: SyntheticBenchmarkConfig,
): Promise<BenchmarkResult> {
  const datasets = config.contracts.map((contract) => generateMockDataset(contract));
  const profiler = new RequestProfiler({ latencyMs: config.latencyMs });

  const rawHandler = (rawUrl: string): Promise<unknown> => {
    const url = decodeURIComponent(rawUrl);
    for (const dataset of datasets) {
      const res = dataset.handleRequest(url);
      if (res) {
        return Promise.resolve(res);
      }
    }

    if (url.includes("/extended/v2/blocks/")) {
      return Promise.resolve({
        statusCode: 200,
        body: {
          json: () =>
            Promise.resolve({
              canonical: true,
              height: 100,
              hash: "0xblock",
              burn_block_time: 1700000000,
              burn_block_height: 100,
            }),
        },
      });
    }

    throw new Error(`Unhandled mock URL in synthetic benchmark: ${url}`);
  };

  config.mockRequestFn(profiler.wrapHandler(rawHandler));

  const testDb = await createTestDatabase();
  const logger = createLogger({ level: 0 });
  const runtime = createHistoricalRuntime({ logger, db: testDb.db });

  const filters = config.contracts.map((contract) => ({
    contractId: contract.contractId,
    handler: () => Promise.resolve(),
  }));

  const startTime = performance.now();
  const result = await runtime.run(filters);
  const endTime = performance.now();
  const durationMs = endTime - startTime;

  await testDb.close();

  if (result.isErr()) {
    throw new Error(`Synthetic benchmark failed: ${JSON.stringify(result.error)}`);
  }

  const totalEvents = datasets.reduce((sum, dataset) => sum + dataset.totalEvents, 0);
  const totalTransactions = datasets.reduce((sum, dataset) => sum + dataset.totalTransactions, 0);
  const totalBlocks = datasets.reduce((sum, dataset) => sum + dataset.totalBlocks, 0);

  const durationSeconds = durationMs / 1000;
  const throughputEventsPerSec = durationSeconds > 0 ? totalEvents / durationSeconds : 0;
  const throughputTxsPerSec = durationSeconds > 0 ? totalTransactions / durationSeconds : 0;
  const requestsPer100Events = totalEvents > 0 ? (profiler.metrics.total / totalEvents) * 100 : 0;

  return {
    name: config.name,
    totalEvents,
    totalTransactions,
    totalBlocks,
    durationMs,
    throughputEventsPerSec: Math.round(throughputEventsPerSec * 10) / 10,
    throughputTxsPerSec: Math.round(throughputTxsPerSec * 10) / 10,
    requestMetrics: { ...profiler.metrics },
    requestsPer100Events: Math.round(requestsPer100Events * 10) / 10,
  };
}
