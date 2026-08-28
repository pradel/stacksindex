import console from "node:console";

import { describe, expect, test, vi } from "vite-plus/test";

import { formatBenchmarkTable, runBenchmarkScenario } from "./runner.ts";

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  request: mockRequest,
}));

describe("historical sync benchmarks", () => {
  test("benchmarks single contract with 500 events (0ms local)", async () => {
    const result = await runBenchmarkScenario(
      {
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
        latencyMs: 0,
      },
      (handler) => {
        mockRequest.mockImplementation(handler);
      },
    );

    // Block queries must be 0 (derived from transactions)
    expect(result.requestMetrics.blocks).toBe(0);

    // Contract logs should be exactly 5 pages for 500 events with 100 limit
    expect(result.requestMetrics.contractLogs).toBe(5);

    // Print report
    // oxlint-disable-next-line no-console
    console.log(`\n${formatBenchmarkTable([result])}`);
  });

  test("benchmarks multi-contract with simulated 10ms network latency", async () => {
    const result = await runBenchmarkScenario(
      {
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
        latencyMs: 10,
      },
      (handler) => {
        mockRequest.mockImplementation(handler);
      },
    );

    expect(result.requestMetrics.blocks).toBe(0);
    expect(result.requestMetrics.contractLogs).toBe(4);

    // oxlint-disable-next-line no-console
    console.log(`\n${formatBenchmarkTable([result])}`);
  });
});
