import process from "node:process";

import { clearAllScenarioBenchmarks, printBenchmarkTable } from "./benchmark.ts";

export function setup(): void {
  process.env.BENCHMARK_RUN_ID ??= `${process.pid}-${Date.now()}`;
}

export function teardown(): void {
  if (process.env.BENCHMARK_REPORT === "true") {
    printBenchmarkTable();
  }
  clearAllScenarioBenchmarks();
}
