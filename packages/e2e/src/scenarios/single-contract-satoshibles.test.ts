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

const recorder = createScenarioRecorder("satoshibles.json");

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => recorder.handleRequest(url, init),
}));

describe("e2E: Satoshibles single-contract scenario", () => {
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

  test("discovers, syncs, decodes, and indexes Satoshibles NFT events in chronological order", async () => {
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
      },
    ]);

    expect(result.isOk()).toBe(true);

    const recordedEvents = tracer.getEvents();
    expect(recordedEvents).toHaveLength(2);

    // Verify strict global chronological order
    tracer.assertChronologicalOrder();

    // Verify first event (mint/log at block 32000)
    expect(recordedEvents[0].blockHeight).toBe(32000);
    expect(recordedEvents[0].txId).toBe("0xsatoshibles_tx_1");
    expect(recordedEvents[0].decoded).toBe(1n);

    // Verify second event (mint/log at block 32010)
    expect(recordedEvents[1].blockHeight).toBe(32010);
    expect(recordedEvents[1].txId).toBe("0xsatoshibles_tx_2");
    expect(recordedEvents[1].decoded).toBe(2n);

    // Verify snapshot format
    const snapshot = tracer.toSnapshot();
    expect(snapshot).toStrictEqual([
      {
        contractId: SATOSHIBLES_CONTRACT,
        blockHeight: 32000,
        txIndex: 0,
        eventIndex: 0,
        topic: "print",
        decoded: 1n,
      },
      {
        contractId: SATOSHIBLES_CONTRACT,
        blockHeight: 32010,
        txIndex: 2,
        eventIndex: 0,
        topic: "print",
        decoded: 2n,
      },
    ]);
  });
});
