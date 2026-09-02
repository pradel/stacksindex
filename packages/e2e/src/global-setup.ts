import process from "node:process";

import { clearAllScenarioBenchmarks, printBenchmarkTable } from "./benchmark.ts";

export function teardown(): void {
  if (process.env.BENCHMARK_REPORT === "true") {
    printBenchmarkTable();
  }
  clearAllScenarioBenchmarks();
}
