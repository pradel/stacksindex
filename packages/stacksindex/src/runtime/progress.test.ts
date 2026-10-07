import { Effect, Logger, Ref } from "effect";
import { describe, expect, test } from "vite-plus/test";

import type { ContractSyncSummary } from "../sync/index.ts";
import {
  computeRunProgress,
  createEtaEstimator,
  logRunProgress,
  type ProgressTrackerState,
} from "./progress.ts";

const summary = (
  overrides: Partial<ContractSyncSummary> & { contractId: string },
): ContractSyncSummary => ({
  doneAtStart: false,
  pagesFetched: 0,
  transactionsFetched: 0,
  eventsStored: 0,
  ...overrides,
});

interface CapturedLog {
  level: string;
  message: unknown;
  annotations: Record<string, string | number | boolean>;
}

const captureLogs = (logs: CapturedLog[]) =>
  Logger.make((options) => {
    const output = Logger.formatStructured.log(options);

    logs.push({
      level: output.level,
      message: output.message,
      // SAFETY: `formatStructured` exposes annotations as an untyped record; these tests read known keys.
      annotations: output.annotations as Record<string, string | number | boolean>,
    });
  });

describe("run progress", () => {
  test("computes percent from known ranges and counts up-to-date contracts as complete", () => {
    const progress = computeRunProgress({
      contracts: [
        summary({
          contractId: "A",
          startBlock: 100,
          endBlock: 199,
          lastBlockHeight: 149,
        }),
        summary({
          contractId: "B",
          doneAtStart: true,
          startBlock: 0,
          endBlock: 49,
          lastBlockHeight: 49,
        }),
      ],
    });

    expect(progress).toStrictEqual({
      completedBlocks: 100,
      totalBlocks: 150,
      percent: 66.7,
      activeContracts: 1,
      doneContracts: 1,
      pagesFetched: 0,
      transactionsFetched: 0,
      eventsStored: 0,
      fromBlock: 0,
      toBlock: 199,
    });
  });

  test("omits percent when a contract has no lower bound", () => {
    const progress = computeRunProgress({
      contracts: [
        summary({ contractId: "A", startBlock: 100, endBlock: 199, lastBlockHeight: 149 }),
        summary({ contractId: "B", endBlock: 299 }),
      ],
    });

    expect(progress.percent).toBeUndefined();
    expect(progress.completedBlocks).toBe(50);
    expect(progress.totalBlocks).toBe(100);
    expect(progress.activeContracts).toBe(2);
  });

  test("uses the chain tip as the target for open-ended contracts", () => {
    const progress = computeRunProgress({
      contracts: [summary({ contractId: "A", initialBlockHeight: 100, lastBlockHeight: 149 })],
      tipBlockHeight: 199,
    });

    expect(progress.percent).toBe(50);
    expect(progress.toBlock).toBe(199);
  });

  test("clamps completed blocks to the contract range", () => {
    const progress = computeRunProgress({
      contracts: [
        summary({ contractId: "A", startBlock: 100, endBlock: 199, lastBlockHeight: 500 }),
      ],
    });

    expect(progress.completedBlocks).toBe(100);
    expect(progress.percent).toBe(100);
  });

  test("treats a missing lastBlockHeight as nothing completed", () => {
    const progress = computeRunProgress({
      contracts: [summary({ contractId: "A", startBlock: 100, endBlock: 199 })],
    });

    expect(progress.completedBlocks).toBe(0);
    expect(progress.percent).toBe(0);
  });

  test("aggregates counts and block bounds across contracts", () => {
    const progress = computeRunProgress({
      contracts: [
        summary({
          contractId: "A",
          startBlock: 100,
          endBlock: 199,
          lastBlockHeight: 149,
          pagesFetched: 3,
          transactionsFetched: 4,
          eventsStored: 5,
        }),
        summary({
          contractId: "B",
          startBlock: 50,
          endBlock: 99,
          lastBlockHeight: 99,
          pagesFetched: 1,
          transactionsFetched: 2,
          eventsStored: 6,
        }),
      ],
    });

    expect(progress).toMatchObject({
      pagesFetched: 4,
      transactionsFetched: 6,
      eventsStored: 11,
      fromBlock: 50,
      toBlock: 199,
    });
  });

  test("returns empty progress for no contracts", () => {
    const progress = computeRunProgress({ contracts: [] });

    expect(progress.percent).toBeUndefined();
    expect(progress.totalBlocks).toBeUndefined();
    expect(progress.activeContracts).toBe(0);
  });
});

describe("eta estimator", () => {
  test("returns undefined without a remaining block count", () => {
    const estimator = createEtaEstimator();

    expect(
      estimator.sample({ completedBlocks: 0, remainingBlocks: undefined, nowMillis: 0 }),
    ).toBeUndefined();
  });

  test("returns undefined until enough samples have been collected", () => {
    const estimator = createEtaEstimator();

    expect(
      estimator.sample({ completedBlocks: 0, remainingBlocks: 600, nowMillis: 0 }),
    ).toBeUndefined();
    expect(
      estimator.sample({ completedBlocks: 100, remainingBlocks: 500, nowMillis: 5_000 }),
    ).toBeUndefined();
    expect(
      estimator.sample({ completedBlocks: 200, remainingBlocks: 400, nowMillis: 10_000 }),
    ).toBeUndefined();
  });

  test("estimates from the exponentially weighted millis-per-block rate", () => {
    const estimator = createEtaEstimator();

    estimator.sample({ completedBlocks: 0, remainingBlocks: 600, nowMillis: 0 });
    estimator.sample({ completedBlocks: 100, remainingBlocks: 500, nowMillis: 5_000 });
    estimator.sample({ completedBlocks: 200, remainingBlocks: 400, nowMillis: 10_000 });

    // 100 blocks per 5s across every sample: 50ms per block. ETA waits for
    // Three completed sampling intervals.
    expect(
      estimator.sample({ completedBlocks: 300, remainingBlocks: 300, nowMillis: 15_000 }),
    ).toBeUndefined();
    expect(
      estimator.sample({ completedBlocks: 400, remainingBlocks: 200, nowMillis: 20_000 }),
    ).toBe(10_000);
  });
});

describe("progress logging", () => {
  test("logs aggregate progress with percent and counts", async () => {
    const logs: CapturedLog[] = [];
    const capture = captureLogs(logs);

    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* Ref.make<ProgressTrackerState>({
          contracts: [
            summary({
              contractId: "A",
              startBlock: 100,
              endBlock: 199,
              lastBlockHeight: 149,
              pagesFetched: 3,
              transactionsFetched: 4,
              eventsStored: 5,
            }),
          ],
          safeBlockHeight: 149,
        });

        yield* logRunProgress({
          chainId: 1,
          state,
          tipBlockHeight: undefined,
          estimator: createEtaEstimator(),
        });
      }).pipe(Effect.provide(Logger.layer([capture]))),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.level).toBe("INFO");
    expect(logs[0]?.message).toBe("Historical sync progress");
    expect(logs[0]?.annotations).toMatchObject({
      chainId: 1,
      phase: "progress",
      percent: 50,
      completedBlocks: 50,
      totalBlocks: 100,
      safeBlockHeight: 149,
      pagesFetched: 3,
      transactionsFetched: 4,
      eventsStored: 5,
      activeContracts: 1,
      doneContracts: 0,
    });
  });

  test("omits percent when bounds are unknown", async () => {
    const logs: CapturedLog[] = [];
    const capture = captureLogs(logs);

    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* Ref.make<ProgressTrackerState>({
          contracts: [summary({ contractId: "A" })],
        });

        yield* logRunProgress({
          chainId: 1,
          state,
          tipBlockHeight: undefined,
          estimator: createEtaEstimator(),
        });
      }).pipe(Effect.provide(Logger.layer([capture]))),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]?.annotations).not.toHaveProperty("percent");
    expect(logs[0]?.annotations).not.toHaveProperty("totalBlocks");
  });

  test("skips until the first snapshot arrives", async () => {
    const logs: CapturedLog[] = [];
    const capture = captureLogs(logs);

    await Effect.runPromise(
      Effect.gen(function* () {
        const state = yield* Ref.make<ProgressTrackerState>({ contracts: [] });

        yield* logRunProgress({
          chainId: 1,
          state,
          tipBlockHeight: undefined,
          estimator: createEtaEstimator(),
        });
      }).pipe(Effect.provide(Logger.layer([capture]))),
    );

    expect(logs).toHaveLength(0);
  });
});
