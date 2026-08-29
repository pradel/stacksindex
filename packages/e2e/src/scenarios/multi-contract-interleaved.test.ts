// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable typescript/no-explicit-any
// oxlint-disable vitest/max-expects
import { createHistoricalRuntime, createLogger, type EventHandler } from "indexer";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createScenarioRecorder } from "../recorder.ts";
import { createTestDatabase, type TestDatabase } from "../test-db.ts";
import { createTraceCollector } from "../tracer.ts";

const SATOSHIBLES_CONTRACT = "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles";
const ALEX_POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

const recorder = createScenarioRecorder("multi-contract.json");

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => recorder.handleRequest(url, init),
}));

describe("e2E: Multi-contract interleaved synchronization scenario", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;
  const logger = createLogger({ level: 0 });

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  beforeEach(async () => {
    await testDb.cleanup();
  });

  afterAll(async () => {
    await recorder.save();
    await testDb.close();
    vi.restoreAllMocks();
  });

  test("interleaves and dispatches events from multiple contracts in strict global chronological order", async () => {
    const tracer = createTraceCollector();

    const satoshiblesHandler: EventHandler = (event) => {
      tracer.record(SATOSHIBLES_CONTRACT, event);
      return Promise.resolve();
    };

    const alexHandler: EventHandler = (event) => {
      tracer.record(ALEX_POOL_CONTRACT, event);
      return Promise.resolve();
    };

    const runtime = createHistoricalRuntime({
      logger,
      db: testDb.db,
    });

    const result = await runtime.run([
      {
        contractId: SATOSHIBLES_CONTRACT,
        handler: satoshiblesHandler,
      },
      {
        contractId: ALEX_POOL_CONTRACT,
        handler: alexHandler,
      },
    ]);

    expect(result.isOk()).toBe(true);

    const recordedEvents = tracer.getEvents();
    expect(recordedEvents).toHaveLength(4);

    // Verify strict global chronological order across interleaved contracts
    tracer.assertChronologicalOrder();

    // Event 1: Satoshibles at block 32000
    expect(recordedEvents[0].contractId).toBe(SATOSHIBLES_CONTRACT);
    expect(recordedEvents[0].blockHeight).toBe(32000);

    // Event 2: Alex at block 32005
    expect(recordedEvents[1].contractId).toBe(ALEX_POOL_CONTRACT);
    expect(recordedEvents[1].blockHeight).toBe(32005);

    // Event 3: Satoshibles at block 32010
    expect(recordedEvents[2].contractId).toBe(SATOSHIBLES_CONTRACT);
    expect(recordedEvents[2].blockHeight).toBe(32010);

    // Event 4: Alex at block 32015
    expect(recordedEvents[3].contractId).toBe(ALEX_POOL_CONTRACT);
    expect(recordedEvents[3].blockHeight).toBe(32015);
  });
});
