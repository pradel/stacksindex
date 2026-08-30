export { generateMockDataset, buildLogsCursor } from "./generator.ts";
export type { GeneratedDataset, MockContractOptions } from "./generator.ts";
export { formatBenchmarkTable, runScenarioBenchmark, runSyntheticBenchmark } from "./runner.ts";
export type {
  BenchmarkResult,
  ScenarioBenchmarkConfig,
  SyntheticBenchmarkConfig,
} from "./runner.ts";
