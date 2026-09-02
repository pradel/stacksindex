// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable typescript/no-explicit-any
// oxlint-disable vitest/max-expects
import { createHistoricalRuntime, createLogger, type EventHandler } from "stacksindex";
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
        startBlock: 47784,
        endBlock: 47784,
      },
    ]);

    expect(result.isOk()).toBe(true);

    const recordedEvents = tracer.getEvents();
    expect(recordedEvents).toHaveLength(3);

    // Verify strict global chronological order (blockHeight, txIndex, eventIndex)
    tracer.assertChronologicalOrder();

    // Verify all 3 events belong to block 47784
    for (const event of recordedEvents) {
      expect(event.blockHeight).toBe(47784);
      expect(event.topic).toBe("print");
    }

    // Verify event 1: tx_index 28
    expect(recordedEvents[0].txIndex).toBe(28);
    expect(recordedEvents[0].eventIndex).toBe(0);
    expect(recordedEvents[0].txId).toBe(
      "0x09c68a8d69a662e93d10fda7d7bb8c4c61487af23ccf6595fb6e1341466e217d",
    );

    // Verify event 2: tx_index 34
    expect(recordedEvents[1].txIndex).toBe(34);
    expect(recordedEvents[1].eventIndex).toBe(0);
    expect(recordedEvents[1].txId).toBe(
      "0xb27807a32a851a931bb0623abf34201097e40afe2fa862c19b6af02d0c298b11",
    );

    // Verify event 3: tx_index 48
    expect(recordedEvents[2].txIndex).toBe(48);
    expect(recordedEvents[2].eventIndex).toBe(0);
    expect(recordedEvents[2].txId).toBe(
      "0xc5c2b57b01170927608158110f634def41af4eb2a2ec3bfd71d8af6f0deac4ae",
    );
  });
});
