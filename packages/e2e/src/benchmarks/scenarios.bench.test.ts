import console from "node:console";

import { describe, expect, test, vi } from "vite-plus/test";

import { createScenarioRecorder } from "../recorder.ts";
import { formatBenchmarkTable, runScenarioBenchmark } from "./runner.ts";

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  request: mockRequest,
}));

describe("mainnet trace benchmarks (e2E fixtures)", () => {
  test("benchmarks bounded startBlock/endBlock scenario on Satoshibles mainnet trace", async () => {
    const recorder = createScenarioRecorder("start-end-block.json");

    const result = await runScenarioBenchmark({
      name: "Mainnet Satoshibles (Block 47784 Bounded, Replay)",
      contractIds: ["SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles"],
      startBlock: 47784,
      endBlock: 47784,
      mockRequestFn: (handler) => {
        mockRequest.mockImplementation(handler);
      },
      requestHandler: (url, init) =>
        recorder.handleRequest(
          url,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          init as { method?: string; headers?: Record<string, string>; body?: string } | undefined,
        ),
      latencyMs: 0,
    });

    // Verification of request budgets
    expect(result.requestMetrics.blocks).toBe(0);
    expect(result.totalEvents).toBe(3);
    expect(result.totalTransactions).toBe(3);

    // oxlint-disable-next-line no-console
    console.log(`\n${formatBenchmarkTable([result])}`);
  });
});
