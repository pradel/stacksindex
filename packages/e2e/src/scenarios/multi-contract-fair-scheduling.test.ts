// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable typescript/no-explicit-any
// oxlint-disable vitest/max-expects
import { sql, type SQL } from "drizzle-orm";
import { createHistoricalRuntime, createLogger, type EventHandler } from "stacksindex";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { assertBenchmarkSnapshot, registerScenarioBenchmark } from "../benchmark.ts";
import { createScenarioRecorder } from "../recorder.ts";
import { createTestDatabase, type TestDatabase } from "../test-db.ts";
import { createTraceCollector } from "../tracer.ts";

const SATOSHIBLES_CONTRACT = "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles";
const BRIDGE_CONTRACT = "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.stacksbridge-satoshibles";

const START_BLOCK = 47784;
const END_BLOCK = 47786;

const recorder = createScenarioRecorder("multi-contract-fair-scheduling.json");

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => recorder.handleRequest(url, init),
}));

async function selectRows<Row>(database: TestDatabase["db"], query: SQL): Promise<Row[]> {
  const result = (await database.execute(query)) as unknown as { rows: Row[] } | Row[];
  if (Array.isArray(result)) {
    return result;
  }
  return result.rows;
}

describe("e2E: Multi-contract fair scheduling scenario", () => {
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
    registerScenarioBenchmark("multi-contract-fair-scheduling", recorder.getBenchmarkSummary());
    await recorder.save();
    await testDb.close();
    vi.restoreAllMocks();
  });

  test("delivers globally ordered events across contracts sharing overlapping block ranges", async () => {
    const tracer = createTraceCollector();

    const satoshiblesHandler: EventHandler = (event) => {
      tracer.record(SATOSHIBLES_CONTRACT, event);
      return Promise.resolve();
    };

    const bridgeHandler: EventHandler = (event) => {
      tracer.record(BRIDGE_CONTRACT, event);
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
        startBlock: START_BLOCK,
        endBlock: END_BLOCK,
      },
      {
        contractId: BRIDGE_CONTRACT,
        handler: bridgeHandler,
        startBlock: START_BLOCK,
        endBlock: END_BLOCK,
      },
    ]);

    expect(result.isOk()).toBe(true);

    const recordedEvents = tracer.getEvents();

    // Satoshibles holds 7 events (47784x3, 47786x4), the bridge holds 18 events
    // (47784x10, 47785x6, 47786x2).
    expect(recordedEvents).toHaveLength(25);

    // Verify strict global chronological order across both contracts
    // (blockHeight, txIndex, eventIndex). Contracts interleave inside block
    // 47784 and block 47785 is bridge-only, so any per-contract-sequential
    // Delivery would violate this ordering.
    tracer.assertChronologicalOrder();

    // Verify every event is within the requested range.
    for (const event of recordedEvents) {
      expect(event.blockHeight).toBeGreaterThanOrEqual(START_BLOCK);
      expect(event.blockHeight).toBeLessThanOrEqual(END_BLOCK);
      expect(event.topic).toBe("print");
    }

    // Verify per-contract routing with no cross-contamination.
    const satoshiblesEvents = tracer.getEventsForContract(SATOSHIBLES_CONTRACT);
    const bridgeEvents = tracer.getEventsForContract(BRIDGE_CONTRACT);
    expect(satoshiblesEvents).toHaveLength(7);
    expect(bridgeEvents).toHaveLength(18);
    for (const event of satoshiblesEvents) {
      expect(event.contractId).toBe(SATOSHIBLES_CONTRACT);
    }
    for (const event of bridgeEvents) {
      expect(event.contractId).toBe(BRIDGE_CONTRACT);
    }

    // Verify bridge events land on blocks 47784, 47785 and 47786.
    const bridge47784 = bridgeEvents.filter((event) => event.blockHeight === 47784);
    const bridge47785 = bridgeEvents.filter((event) => event.blockHeight === 47785);
    const bridge47786 = bridgeEvents.filter((event) => event.blockHeight === 47786);
    expect(bridge47784).toHaveLength(10);
    expect(bridge47785).toHaveLength(6);
    expect(bridge47786).toHaveLength(2);

    // Verify exact bridge ordering within each block. Every bridge log sits at
    // Event_index 1, mixed with an nft_asset event at index 0 in the same tx.
    expect(bridge47784.map((event) => event.txIndex)).toStrictEqual([
      4, 5, 6, 7, 8, 29, 30, 31, 32, 33,
    ]);
    expect(bridge47784.map((event) => event.txId)).toStrictEqual([
      "0xc9d4f94da65a02bd40d620d3bf12fece656d08927ddc9ff6bd75cbcb54b81f09",
      "0x3aa1adbc56f8ce2665e10d36ab9bc29c7abb3fe3dd53c729ce36d755ea42434f",
      "0xc3b6019fd4c1afc3b3ac0f30efcb6e19701d797d1b479df721736cd45ec13ee4",
      "0x1f6b9707a4c39af8e62d394be25ca689dabc029b00fc512e1333e7a9e7805e9c",
      "0x1ad6dafaca875df5283fb9b64cbb5c3e0e15a2d06dc180d2c6fd29db8292939f",
      "0x50e2f4353311a944f71e035e54d8cddd2f985f3772951ae443e8caae6d2ff222",
      "0x08cecc2f6cae33a667f5f64caf7dfb67ecf65f461db167ea6d86d6c57ee3ba96",
      "0x57231862a83de9ed0993152958e17e1a46ee24457962106ee90edf15f732a956",
      "0xfa2ba903f1012dd590dfeae07dd36896ab95c93f824583a56f85aca3a35dcd9a",
      "0x4d2489d8e0e8cab63ae31a404f82a9d74cc44e1e55fc16a7b4286edc70e6f87e",
    ]);
    expect(bridge47785.map((event) => event.txIndex)).toStrictEqual([11, 12, 13, 14, 15, 16]);
    expect(bridge47785.map((event) => event.txId)).toStrictEqual([
      "0x730644e98cfaa5d794f374e90614cd88bf61313d06a996259b97ad1f8dab21ab",
      "0xc5936f0c7fa99be07c9d235ecf81e8773b95dea69b22209f0b434401abaffc47",
      "0x98cc5ac782c5faf31dcfceb1f01515c05e31f9482605cacadd4066c48cbe8d30",
      "0x97a44c3a35c8920e837ee4becac8e16b32578a58ed2f8e52e09a66119bbf070c",
      "0xfd0c2cfb3d89353e81df7afd2dc975fc1067653b68f93a3a0719f7bf07f9accb",
      "0x4280b63ed7da7ee0465ec5c86773c8b950ccdbdf6f9e3b780ab2199066887b77",
    ]);
    expect(bridge47786.map((event) => event.txIndex)).toStrictEqual([31, 36]);
    expect(bridge47786.map((event) => event.txId)).toStrictEqual([
      "0x44f98830dd4bb6259f1362795404a683c54e172c31b9e2ab295b9a377d671172",
      "0xa8a7105802eebeeb754f122957d5306f12cf6c2114443ee0ecdbfac8460df875",
    ]);
    expect(bridgeEvents.every((event) => event.eventIndex === 1)).toBe(true);

    // Verify the interleaved block sequence proves globally ordered delivery:
    // 47784 alternates bridge/satoshibles by tx_index, 47785 is bridge-only,
    // 47786 alternates again.
    expect(recordedEvents.map((event) => event.blockHeight)).toStrictEqual([
      47784, 47784, 47784, 47784, 47784, 47784, 47784, 47784, 47784, 47784, 47784, 47784, 47784,
      47785, 47785, 47785, 47785, 47785, 47785, 47786, 47786, 47786, 47786, 47786, 47786,
    ]);

    // Verify both contracts are marked complete at endBlock.
    const progress = await selectRows<{
      contractId: string;
      cursor: string | null;
      lastBlockHeight: string | number | bigint;
      isComplete: boolean;
    }>(
      testDb.db,
      sql`select "contract_id" as "contractId", "cursor", "lastBlockHeight", "is_complete" as "isComplete" from "sync_progress"`,
    );
    expect(progress).toHaveLength(2);
    for (const row of progress) {
      expect(row.cursor).toBeNull();
      expect(row.isComplete).toBe(true);
      expect(Number(row.lastBlockHeight)).toBe(END_BLOCK);
    }

    // Verify the indexing checkpoint advanced to the shared endBlock.
    const checkpoints = await selectRows<{ blockHeight: string | number | bigint }>(
      testDb.db,
      sql`select "blockHeight" from "checkpoints"`,
    );
    expect(checkpoints).toHaveLength(1);
    expect(Number(checkpoints[0].blockHeight)).toBe(END_BLOCK);

    // Verify blocks are cached once and shared across contracts. The sync
    // Sweeps one logs page past endBlock plus the cursor-discovery backlog, so
    // The store holds 24 blocks while indexing filters delivery to the range.
    const storedBlocks = await selectRows<{ height: string | number | bigint }>(
      testDb.db,
      sql`select "height" from "blocks"`,
    );
    const storedHeights = storedBlocks
      .map((row) => Number(row.height))
      .sort((leftHeight, rightHeight) => leftHeight - rightHeight);
    expect(storedHeights).toStrictEqual([
      47669, 47675, 47678, 47681, 47690, 47693, 47695, 47697, 47698, 47706, 47708, 47711, 47713,
      47729, 47731, 47733, 47767, 47771, 47773, 47779, 47783, 47784, 47785, 47786,
    ]);
    expect(storedHeights).toContain(47784);
    expect(storedHeights).toContain(47785);
    expect(storedHeights).toContain(47786);

    // 76 cached transactions back 25 delivered events: blocks are fetched once
    // And shared, transactions deduplicate across pages.
    const txCount = await selectRows<{ count: string | number | bigint }>(
      testDb.db,
      sql`select count(*) as "count" from "transactions"`,
    );
    expect(Number(txCount[0].count)).toBe(76);

    const eventCount = await selectRows<{ count: string | number | bigint }>(
      testDb.db,
      sql`select count(*) as "count" from "events"`,
    );
    expect(Number(eventCount[0].count)).toBe(83);

    // Verify API call count benchmark snapshot
    assertBenchmarkSnapshot(recorder.getBenchmarkSummary());
  });
});
