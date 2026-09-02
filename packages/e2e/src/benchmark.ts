import console from "node:console";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { URL } from "node:url";

import { expect } from "vite-plus/test";

export interface BenchmarkSummary {
  totalCalls: number;
  endpoints: Record<string, number>;
}

export interface BenchmarkTracker {
  recordCall: (method: string, rawUrl: string) => void;
  getSummary: () => BenchmarkSummary;
  reset: () => void;
}

/**
 * Normalizes an API URL and HTTP method into a canonical parameterized route pattern.
 * Strips query parameters, host, protocol, and collapses dynamic resource IDs.
 */
export function normalizeRoute(method: string, rawUrl: string): string {
  let pathname = rawUrl;
  try {
    const { pathname: parsedPathname } = new URL(rawUrl, "http://localhost");
    pathname = parsedPathname;
  } catch {
    const queryIndex = rawUrl.indexOf("?");
    if (queryIndex !== -1) {
      pathname = rawUrl.slice(0, queryIndex);
    }
  }

  const upperMethod = method.toUpperCase();

  // Known Hiro / Stacks blockchain API routes:
  if (/^\/extended\/v1\/contract\/[^/]+$/u.test(pathname)) {
    return `${upperMethod} /extended/v1/contract/:contract_id`;
  }
  if (/^\/extended\/v1\/tx\/[^/]+$/u.test(pathname)) {
    return `${upperMethod} /extended/v1/tx/:tx_id`;
  }
  if (pathname === "/extended/v1/status" || pathname === "/extended") {
    return `${upperMethod} /extended/v1/status`;
  }
  if (/^\/extended\/v2\/blocks\/[^/]+$/u.test(pathname)) {
    return `${upperMethod} /extended/v2/blocks/:height_or_hash`;
  }
  if (/^\/extended\/v2\/smart-contracts\/[^/]+\/logs$/u.test(pathname)) {
    return `${upperMethod} /extended/v2/smart-contracts/:contract_id/logs`;
  }
  if (/^\/extended\/v3\/blocks\/[^/]+\/transactions$/u.test(pathname)) {
    return `${upperMethod} /extended/v3/blocks/:height_or_hash/transactions`;
  }
  if (/^\/extended\/v3\/principals\/[^/]+\/transactions$/u.test(pathname)) {
    return `${upperMethod} /extended/v3/principals/:principal/transactions`;
  }
  if (/^\/extended\/v3\/transactions\/[^/]+\/events$/u.test(pathname)) {
    return `${upperMethod} /extended/v3/transactions/:tx_id/events`;
  }
  if (/^\/extended\/v3\/transactions\/[^/]+$/u.test(pathname)) {
    return `${upperMethod} /extended/v3/transactions/:tx_id`;
  }
  if (/^\/v2\/contracts\/call-read\/[^/]+\/[^/]+\/[^/]+$/u.test(pathname)) {
    return `${upperMethod} /v2/contracts/call-read/:contract_address/:contract_name/:function_name`;
  }
  if (/^\/v2\/contracts\/call-read\/[^/]+\/[^/]+$/u.test(pathname)) {
    return `${upperMethod} /v2/contracts/call-read/:contract_id/:function_name`;
  }

  // Fallback normalization: collapse hex hashes, Stacks contract/principal identifiers, and numeric IDs
  const normalizedPath = pathname
    .replace(/0x[a-fA-F0-9]{64}/gu, ":hash")
    .replace(/S[PM][a-zA-Z0-9]{28,41}(?:\.[a-zA-Z0-9_-]+)?/gu, ":principal")
    .replace(/\/\d+(?=\/|$)/gu, "/:id");

  return `${upperMethod} ${normalizedPath}`;
}

/**
 * Creates an in-memory tracker that tallies API calls grouped by normalized route.
 */
export function createBenchmarkTracker(): BenchmarkTracker {
  let counts: Record<string, number> = {};
  let totalCalls = 0;

  return {
    recordCall(method: string, rawUrl: string) {
      const route = normalizeRoute(method, rawUrl);
      counts[route] = (counts[route] ?? 0) + 1;
      totalCalls += 1;
    },

    getSummary(): BenchmarkSummary {
      const endpoints: Record<string, number> = {};
      const sortedKeys = Object.keys(counts).sort();
      for (const key of sortedKeys) {
        endpoints[key] = counts[key];
      }
      return {
        totalCalls,
        endpoints,
      };
    },

    reset() {
      counts = {};
      totalCalls = 0;
    },
  };
}

const inMemoryBenchmarks = new Map<string, BenchmarkSummary>();

export function getBenchmarkRunDirectory(): string {
  process.env.BENCHMARK_RUN_ID ??= `${process.ppid || process.pid}-${Date.now()}`;
  return path.join(os.tmpdir(), "stacksindex-benchmarks", process.env.BENCHMARK_RUN_ID);
}

/**
 * Registers a scenario's benchmark summary in memory and saves a dedicated file
 * in the run directory so that concurrent Vitest worker threads don't contend or overwrite each other.
 */
export function registerScenarioBenchmark(scenarioName: string, summary: BenchmarkSummary): void {
  inMemoryBenchmarks.set(scenarioName, summary);
  try {
    const runDir = getBenchmarkRunDirectory();
    fs.mkdirSync(runDir, { recursive: true });
    const sanitizedScenario = scenarioName.replace(/[^a-zA-Z0-9_-]/gu, "_");
    const uniqueWorkerSuffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workerFilePath = path.join(runDir, `${sanitizedScenario}-${uniqueWorkerSuffix}.json`);
    fs.writeFileSync(workerFilePath, JSON.stringify({ scenarioName, summary }, null, 2), "utf8");
  } catch {
    // File writing is best-effort for cross-process aggregation
  }
}

/**
 * Loads all benchmark summaries recorded across scenarios for the current run.
 */
export function loadAllScenarioBenchmarks(): Map<string, BenchmarkSummary> {
  const result = new Map<string, BenchmarkSummary>(inMemoryBenchmarks);
  try {
    const runDir = getBenchmarkRunDirectory();
    if (!fs.existsSync(runDir)) {
      return result;
    }
    const jsonFiles = fs.readdirSync(runDir).filter((file) => file.endsWith(".json"));
    for (const entry of jsonFiles) {
      const filePath = path.join(runDir, entry);
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        scenarioName?: string;
        summary?: BenchmarkSummary;
      };
      if (data.scenarioName && data.summary) {
        result.set(data.scenarioName, data.summary);
      }
    }
  } catch {
    // Ignore read errors
  }
  return result;
}

/**
 * Clears scenario benchmarks from memory and deletes the run directory for the current run.
 */
export function clearAllScenarioBenchmarks(): void {
  inMemoryBenchmarks.clear();
  try {
    const runDir = getBenchmarkRunDirectory();
    if (fs.existsSync(runDir)) {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore removal errors
  }
}

function padRight(str: string, length: number): string {
  return str.length >= length ? str : str + " ".repeat(length - str.length);
}

function padLeft(str: string, length: number): string {
  return str.length >= length ? str : " ".repeat(length - str.length) + str;
}

/**
 * Formats scenario benchmark summaries into a formatted ASCII table.
 */
export function formatBenchmarkTable(benchmarks: Map<string, BenchmarkSummary>): string {
  if (benchmarks.size === 0) {
    return "";
  }

  interface TableRow {
    scenario: string;
    endpoint: string;
    calls: string;
    isTotal?: boolean;
  }

  const rows: TableRow[] = [];
  let grandTotal = 0;

  const sortedScenarios = Array.from(benchmarks.keys()).sort();

  for (const scenario of sortedScenarios) {
    const summary = benchmarks.get(scenario);
    if (summary) {
      grandTotal += summary.totalCalls;
      const endpoints = Object.entries(summary.endpoints);

      if (endpoints.length === 0) {
        rows.push({
          scenario,
          endpoint: "(no API calls)",
          calls: "0",
        });
      } else {
        let isFirst = true;
        for (const [endpoint, count] of endpoints) {
          rows.push({
            scenario: isFirst ? scenario : "",
            endpoint,
            calls: String(count),
          });
          isFirst = false;
        }

        rows.push({
          scenario: "",
          endpoint: "Total",
          calls: String(summary.totalCalls),
          isTotal: true,
        });
      }
    }
  }

  const colScenarioHeader = "Scenario";
  const colEndpointHeader = "Endpoint";
  const colCallsHeader = "Calls";

  let maxScenarioLen = colScenarioHeader.length;
  let maxEndpointLen = colEndpointHeader.length;
  let maxCallsLen = colCallsHeader.length;

  for (const row of rows) {
    if (row.scenario.length > maxScenarioLen) {
      maxScenarioLen = row.scenario.length;
    }
    if (row.endpoint.length > maxEndpointLen) {
      maxEndpointLen = row.endpoint.length;
    }
    if (row.calls.length > maxCallsLen) {
      maxCallsLen = row.calls.length;
    }
  }

  if (benchmarks.size > 1) {
    const grandTotalStr = String(grandTotal);
    if (grandTotalStr.length > maxCallsLen) {
      maxCallsLen = grandTotalStr.length;
    }
  }

  const wScenario = maxScenarioLen + 2;
  const wEndpoint = maxEndpointLen + 2;
  const wCalls = maxCallsLen + 2;

  const topBorder = `+${"-".repeat(wScenario)}+${"-".repeat(wEndpoint)}+${"-".repeat(wCalls)}+`;
  const headerRow = `| ${padRight(colScenarioHeader, maxScenarioLen)} | ${padRight(colEndpointHeader, maxEndpointLen)} | ${padLeft(colCallsHeader, maxCallsLen)} |`;
  const headerSeparator = `+${"-".repeat(wScenario)}+${"-".repeat(wEndpoint)}+${"-".repeat(wCalls)}+`;
  const scenarioSeparator = `+${"-".repeat(wScenario)}+${"-".repeat(wEndpoint)}+${"-".repeat(wCalls)}+`;
  const bottomBorder = `+${"-".repeat(wScenario)}+${"-".repeat(wEndpoint)}+${"-".repeat(wCalls)}+`;

  const lines: string[] = [
    "E2E API Call-Count Benchmark Summary",
    topBorder,
    headerRow,
    headerSeparator,
  ];

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const line = `| ${padRight(row.scenario, maxScenarioLen)} | ${padRight(row.endpoint, maxEndpointLen)} | ${padLeft(row.calls, maxCallsLen)} |`;
    lines.push(line);

    if (index + 1 < rows.length) {
      const nextRow = rows[index + 1];
      if (nextRow.scenario !== "" && row.isTotal) {
        lines.push(scenarioSeparator);
      }
    }
  }

  if (benchmarks.size > 1) {
    lines.push(scenarioSeparator);
    const grandTotalLine = `| ${padRight("Grand Total", maxScenarioLen)} | ${padRight("All Scenarios", maxEndpointLen)} | ${padLeft(String(grandTotal), maxCallsLen)} |`;
    lines.push(grandTotalLine);
  }

  lines.push(bottomBorder);

  return lines.join("\n");
}

/**
 * Prints the formatted benchmark table to stdout.
 */
export function printBenchmarkTable(benchmarks?: Map<string, BenchmarkSummary>): void {
  const data = benchmarks ?? loadAllScenarioBenchmarks();
  const table = formatBenchmarkTable(data);
  if (table) {
    console.log(`\n${table}\n`);
  }
}

interface VitestSnapshotState {
  match: (options: {
    testName: string;
    received: unknown;
    isInline: boolean;
    message?: string;
  }) => { pass: boolean; message?: () => string };
}

interface VitestExpectState {
  currentTestName?: string;
  snapshotState?: VitestSnapshotState;
}

/**
 * Asserts that a benchmark summary matches its Vitest snapshot.
 * Utilizes the active Vitest SnapshotState from expect.getState()
 * to guarantee robust snapshot resolution across monorepos and task runners.
 */
export function assertBenchmarkSnapshot(summary: BenchmarkSummary, hint?: string): void {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const state = expect.getState() as unknown as VitestExpectState;
  if (state.snapshotState) {
    const result = state.snapshotState.match({
      testName: state.currentTestName ?? "",
      received: summary,
      isInline: false,
      message: hint,
    });
    if (!result.pass) {
      const message = typeof result.message === "function" ? result.message() : "Snapshot mismatch";
      throw new Error(message);
    }
  } else {
    expect(summary).toMatchSnapshot(hint);
  }
}
