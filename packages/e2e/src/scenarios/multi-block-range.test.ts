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

const recorder = createScenarioRecorder("multi-block-range.json");

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: (
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => recorder.handleRequest(url, init),
}));

describe("e2E: Multi-block bounded range scenario", () => {
  const database = createScenarioDatabase();
  const logger = createLogger({ level: 0 });

  beforeAll(async () => {
    await database.setup();
  });

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    registerScenarioBenchmark("multi-block-range", recorder.getBenchmarkSummary());
    await recorder.save();
    await database.teardown();
    vi.restoreAllMocks();
  });

  test("syncs and indexes events across multiple blocks within startBlock and endBlock", async () => {
    const { tracer, events } = await runScenario({
      db: database.db,
      logger,
      contracts: [
        { contractId: SATOSHIBLES_CONTRACT, startBlock: START_BLOCK, endBlock: END_BLOCK },
      ],
    });

    // Block 47784 holds 3 events, block 47786 holds 4 events.
    expect(events).toHaveLength(7);

    // Verify strict global chronological order (blockHeight, txIndex, eventIndex)
    tracer.assertChronologicalOrder();

    // Verify every event is within the requested range and spans more than one block.
    const heights = new Set(events.map((event) => event.blockHeight));
    expect(heights.size).toBeGreaterThan(1);
    for (const event of events) {
      expect(event.blockHeight).toBeGreaterThanOrEqual(START_BLOCK);
      expect(event.blockHeight).toBeLessThanOrEqual(END_BLOCK);
      expect(event.topic).toBe("print");
    }

    // Verify per-block event counts.
    const block47784 = events.filter((event) => event.blockHeight === 47784);
    const block47786 = events.filter((event) => event.blockHeight === 47786);
    expect(block47784).toHaveLength(3);
    expect(block47786).toHaveLength(4);

    // Verify exact ordering within block 47784 (tx_index 28, 34, 48).
    expect(block47784.map((event) => event.txIndex)).toStrictEqual([28, 34, 48]);
    expect(block47784[0].txId).toBe(
      "0x09c68a8d69a662e93d10fda7d7bb8c4c61487af23ccf6595fb6e1341466e217d",
    );
    expect(block47784[1].txId).toBe(
      "0xb27807a32a851a931bb0623abf34201097e40afe2fa862c19b6af02d0c298b11",
    );
    expect(block47784[2].txId).toBe(
      "0xc5c2b57b01170927608158110f634def41af4eb2a2ec3bfd71d8af6f0deac4ae",
    );

    // Verify exact ordering within block 47786 (tx_index 3, 4, 58, 66).
    expect(block47786.map((event) => event.txIndex)).toStrictEqual([3, 4, 58, 66]);
    expect(block47786[0].txId).toBe(
      "0x3c1593a34589e64780c8d6a0bff94d91187efabbd93a4e5dc082c9a7bbac27ed",
    );
    expect(block47786[1].txId).toBe(
      "0xb5a3b51429b6aeec2487bf244e663128524ab155ca910c56d8b7cad21e0ed50d",
    );
    expect(block47786[2].txId).toBe(
      "0x7548822d0b75342d39a7f1c7f0e19d921c74454f36edc382642ad9f1ca81d494",
    );
    expect(block47786[3].txId).toBe(
      "0xae5ed73dc2456694e5d7e46c9e6ae8cff4a0f659d56bc9afdf95bb2fe207b47a",
    );

    // Verify sync progress is marked complete at endBlock.
    await expectProgress(database.db, SATOSHIBLES_CONTRACT, {
      cursor: null,
      lastBlockHeight: END_BLOCK,
      isComplete: true,
    });

    // Verify the indexing checkpoint advanced to endBlock.
    await expectCheckpoint(database.db, END_BLOCK);

    // Verify raw sync store holds both blocks and all indexed transactions/events.
    await expectStoredBlockHeights(database.db, [47784, 47786]);
    await expectTableCount(database.db, "transactions", 7);
    await expectTableCount(database.db, "events", 7);

    // Verify API call count benchmark snapshot
    assertBenchmarkSnapshot(recorder.getBenchmarkSummary());
  });
});
