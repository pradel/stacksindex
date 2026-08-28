import { performance } from "node:perf_hooks";

import { createDatabase, createHistoricalRuntime, createLogger } from "indexer";

import { generateMockDataset, type MockContractOptions } from "./generator.ts";
import { BenchmarkHarness, type BenchmarkResult } from "./harness.ts";

export interface BenchmarkScenario {
  name: string;
  contracts: MockContractOptions[];
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

export async function runBenchmarkScenario(
  scenario: BenchmarkScenario,
  mockRequestFn: (fn: (url: string) => Promise<unknown>) => void,
): Promise<BenchmarkResult> {
  const datasets = scenario.contracts.map((contract) => generateMockDataset(contract));
  const harness = new BenchmarkHarness({
    datasets,
    latencyMs: scenario.latencyMs ?? 0,
  });

  mockRequestFn(harness.createMockRequestHandler());

  const indexerDatabase = await createDatabase({ kind: "pglite" });
  const logger = createLogger({ level: 0 });
  const runtime = createHistoricalRuntime({ logger, db: indexerDatabase.db });

  const filters = scenario.contracts.map((contract) => ({
    contractId: contract.contractId,
    handler: () => Promise.resolve(),
  }));

  const startTime = performance.now();
  const result = await runtime.run(filters);
  const endTime = performance.now();
  const durationMs = endTime - startTime;

  await indexerDatabase.close();

  if (result.isErr()) {
    throw new Error(`Benchmark failed: ${JSON.stringify(result.error)}`);
  }

  const totalEvents = scenario.contracts.reduce((sum, contract) => sum + contract.totalEvents, 0);
  return harness.recordResult(scenario.name, totalEvents, durationMs);
}
