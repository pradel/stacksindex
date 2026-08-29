// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable typescript/no-explicit-any
// oxlint-disable vitest/max-expects
// oxlint-disable vitest/no-conditional-in-test
import { createHistoricalRuntime, createLogger, type EventHandler } from "indexer";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createScenarioRecorder } from "../recorder.ts";
import { createTestDatabase, type TestDatabase } from "../test-db.ts";
import { createTraceCollector } from "../tracer.ts";

const ALEX_POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

const recorder = createScenarioRecorder("alex-pool.json");

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => recorder.handleRequest(url, init),
}));

describe("e2E: ALEX DEX single-contract scenario", () => {
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

  test("discovers, syncs, decodes, and indexes ALEX pool logs in chronological order", async () => {
    const tracer = createTraceCollector();
    const readOnlyResults: unknown[] = [];

    const alexHandler: EventHandler = async (event, { client }) => {
      tracer.record(ALEX_POOL_CONTRACT, event);

      // Perform a read-only call pinned at the current event block height tip
      const readRes = await client.callReadOnly(ALEX_POOL_CONTRACT, "get-pool-count");
      if (readRes.isOk()) {
        readOnlyResults.push(readRes.value);
      }
    };

    const runtime = createHistoricalRuntime({
      logger,
      db: testDb.db,
    });

    const result = await runtime.run([
      {
        contractId: ALEX_POOL_CONTRACT,
        handler: alexHandler,
      },
    ]);

    expect(result.isOk()).toBe(true);

    const recordedEvents = tracer.getEvents();
    expect(recordedEvents).toHaveLength(2);

    // Verify strict global chronological order
    tracer.assertChronologicalOrder();

    // Verify first event
    expect(recordedEvents[0].blockHeight).toBe(47120);
    expect(recordedEvents[0].txId).toBe("0xalex_tx_1");
    expect(recordedEvents[0].decoded).toBe(1n);

    // Verify second event
    expect(recordedEvents[1].blockHeight).toBe(47125);
    expect(recordedEvents[1].txId).toBe("0xalex_tx_2");
    expect(recordedEvents[1].decoded).toBe(2n);

    // Verify read-only contract calls
    expect(readOnlyResults).toHaveLength(2);
    expect(readOnlyResults[0]).toMatchObject({ okay: true });
    expect(readOnlyResults[1]).toMatchObject({ okay: true });

    // Verify CSV export
    const csv = tracer.exportCsv();
    expect(csv).toContain("contract_id,block_height,tx_index,event_index,tx_id,topic,value_repr");
    expect(csv).toContain(ALEX_POOL_CONTRACT);
    expect(csv).toContain("47120");
    expect(csv).toContain("47125");
  });
});
