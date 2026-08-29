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

const recorder = createScenarioRecorder("start-end-block.json");

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => recorder.handleRequest(url, init),
}));

describe("e2E: Bounded startBlock and endBlock scenario", () => {
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

  test("restricts event synchronization and indexing strictly within startBlock and endBlock", async () => {
    const tracer = createTraceCollector();

    const satoshiblesHandler: EventHandler = (event) => {
      tracer.record(SATOSHIBLES_CONTRACT, event);
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
        startBlock: 32020,
        endBlock: 32030,
      },
    ]);

    expect(result.isOk()).toBe(true);

    const recordedEvents = tracer.getEvents();
    expect(recordedEvents).toHaveLength(2);

    // Verify strict global chronological order
    tracer.assertChronologicalOrder();

    // Verify all recorded events are within [startBlock, endBlock]
    for (const event of recordedEvents) {
      expect(event.blockHeight).toBeGreaterThanOrEqual(32020);
      expect(event.blockHeight).toBeLessThanOrEqual(32030);
    }

    expect(recordedEvents[0].blockHeight).toBe(32020);
    expect(recordedEvents[0].txId).toBe("0xbound_tx_32020");
    expect(recordedEvents[0].decoded).toBe(20n);

    expect(recordedEvents[1].blockHeight).toBe(32030);
    expect(recordedEvents[1].txId).toBe("0xbound_tx_32030");
    expect(recordedEvents[1].decoded).toBe(30n);
  });
});
