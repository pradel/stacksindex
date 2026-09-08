// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable typescript/no-explicit-any
// oxlint-disable vitest/max-expects
import { createLogger } from "stacksindex";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { assertBenchmarkSnapshot, registerScenarioBenchmark } from "../benchmark.ts";
import { createScenarioRecorder } from "../recorder.ts";
import {
  createScenarioDatabase,
  expectCheckpoint,
  expectProgress,
  expectStoredBlockHeights,
  expectTableCount,
  runScenario,
} from "../scenario.ts";

const SATOSHIBLES_CONTRACT = "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles";

const START_BLOCK = 47784;
const END_BLOCK = 47786;

// Reuses the multi-block-range fixture: the requests for the first run are
// Byte-identical, so no second fixture file is needed.
const recorder = createScenarioRecorder("multi-block-range.json");

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => recorder.handleRequest(url, init),
}));

describe("e2E: Resume with idempotent re-run scenario", () => {
  const database = createScenarioDatabase();
  const logger = createLogger({ level: 0 });

  beforeAll(async () => {
    await database.setup();
  });

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    registerScenarioBenchmark("resume-idempotent-rerun", recorder.getBenchmarkSummary());
    await recorder.save();
    await database.teardown();
    vi.restoreAllMocks();
  });

  test("second run on the same database performs no API calls and delivers no events", async () => {
    const contracts = [
      { contractId: SATOSHIBLES_CONTRACT, startBlock: START_BLOCK, endBlock: END_BLOCK },
    ];

    // First run backfills 7 events across blocks 47784 and 47786.
    const first = await runScenario({ db: database.db, logger, contracts });
    expect(first.events).toHaveLength(7);
    first.tracer.assertChronologicalOrder();

    await expectProgress(database.db, SATOSHIBLES_CONTRACT, {
      cursor: null,
      lastBlockHeight: END_BLOCK,
      isComplete: true,
    });
    await expectCheckpoint(database.db, END_BLOCK);

    // Second run on the same database resumes from saved progress: the
    // Contract is already complete, the checkpoint already covers endBlock,
    // So no handler is invoked.
    const second = await runScenario({ db: database.db, logger, contracts });
    expect(second.events).toHaveLength(0);

    // Sync state is untouched by the no-op run.
    await expectProgress(database.db, SATOSHIBLES_CONTRACT, {
      cursor: null,
      lastBlockHeight: END_BLOCK,
      isComplete: true,
    });
    await expectCheckpoint(database.db, END_BLOCK);
    await expectStoredBlockHeights(database.db, [47784, 47786]);
    await expectTableCount(database.db, "transactions", 7);
    await expectTableCount(database.db, "events", 7);

    // The combined API call count matches a single run exactly, proving the
    // Second run performed zero API calls.
    assertBenchmarkSnapshot(recorder.getBenchmarkSummary());
  });
});
