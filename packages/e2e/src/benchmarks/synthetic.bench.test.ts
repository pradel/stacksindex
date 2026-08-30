import console from "node:console";

import { describe, expect, test, vi } from "vite-plus/test";

import { formatBenchmarkTable, runSyntheticBenchmark } from "./runner.ts";

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  request: mockRequest,
}));

describe("synthetic stress benchmarks", () => {
  test("benchmarks single contract with 500 events (0ms local)", async () => {
    const result = await runSyntheticBenchmark({
      name: "Single Contract (500 events, 250 txs, 84 blocks, 0ms latency)",
      contracts: [
        {
          contractId: "SP123.token-a",
          deploymentBlock: 100,
          totalEvents: 500,
          eventsPerPage: 100,
          eventsPerTx: 2,
          txsPerBlock: 3,
        },
      ],
      mockRequestFn: (handler) => {
        mockRequest.mockImplementation(handler);
      },
      latencyMs: 0,
    });

    expect(result.requestMetrics.blocks).toBe(0);
    expect(result.requestMetrics.contractLogs).toBe(5);

    // oxlint-disable-next-line no-console
    console.log(`\n${formatBenchmarkTable([result])}`);
  });

  test("benchmarks multi-contract with simulated 10ms network latency", async () => {
    const result = await runSyntheticBenchmark({
      name: "Multi-Contract (2 contracts x 200 events, 10ms simulated latency)",
      contracts: [
        {
          contractId: "SP123.token-a",
          deploymentBlock: 100,
          totalEvents: 200,
          eventsPerPage: 100,
          eventsPerTx: 2,
          txsPerBlock: 3,
        },
        {
          contractId: "SP456.token-b",
          deploymentBlock: 100,
          totalEvents: 200,
          eventsPerPage: 100,
          eventsPerTx: 2,
          txsPerBlock: 3,
        },
      ],
      mockRequestFn: (handler) => {
        mockRequest.mockImplementation(handler);
      },
      latencyMs: 10,
    });

    expect(result.requestMetrics.blocks).toBe(0);
    expect(result.requestMetrics.contractLogs).toBe(4);

    // oxlint-disable-next-line no-console
    console.log(`\n${formatBenchmarkTable([result])}`);
  });
});
