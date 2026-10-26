import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  assertBenchmarkSnapshot,
  registerScenarioBenchmark,
  type BenchmarkSummary,
} from "../benchmark.ts";
import { createScenarioRecorder } from "../recorder.ts";
import {
  contractName,
  createScenarioDatabase,
  expectBlockSourceProgress,
  expectStoredBlockHeights,
  expectTableCount,
  runScenario,
} from "../scenario.ts";

const SATOSHIBLES_CONTRACT = "SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles";

// Satoshibles prints 3 events at 47784 and 4 at 47786 (see multi-block-range).
const CONTRACT_START = 47784;

const CONTRACT_END = 47786;

// Interval below one blocks page: several heights share a window. Its
// StartBlock is not aligned on the interval, and endBlock is not a height it
// Runs at.
const EVERY_7 = { interval: 7, startBlock: 47779, endBlock: 47830 };

// Interval above one blocks page: each window holds a single height.
const EVERY_50 = { interval: 50, startBlock: 47736, endBlock: 47836 };

const EVERY_7_HEIGHTS = [47779, 47786, 47793, 47800, 47807, 47814, 47821, 47828];

const EVERY_50_HEIGHTS = [47736, 47786, 47836];

// Mainnet block 47786, as `GET /extended/v2/blocks/47786` reports it.
const BLOCK_47786 = {
  hash: "0x56f3d720a2a4bce5d74f99868044049ce2fb04b1704f166f58823b637ea38794",
  indexBlockHash: "0xf6546e8ed5330fbdd462a7f90ce4736dbc9b6f6b32dfa49790014f6528453cdb",
  blockTime: 1644171646,
};

const BLOCK_47828 = {
  hash: "0xfc876d3c70750d86546297912588ef12d7c81bb4f1e22022c6ad4eec7397a444",
  indexBlockHash: "0xa26c709b55c3929cb7bf6b999bf1f9c8804979158b8d151f3fb2abb122eabe25",
  blockTime: 1644198926,
};

const recorder = createScenarioRecorder("block-intervals.json");

/** Requests per route made between two benchmark summaries. */
function requestsSince(before: BenchmarkSummary, after: BenchmarkSummary): Record<string, number> {
  return Object.fromEntries(
    Object.entries(after.endpoints)
      .map(([route, count]): [string, number] => [route, count - (before.endpoints[route] ?? 0)])
      .filter(([, count]) => count > 0),
  );
}

describe("e2E: Block interval sources scenario", () => {
  const database = createScenarioDatabase();

  beforeAll(async () => {
    vi.stubGlobal(
      "fetch",
      (
        url: string | URL | Request,
        init?: { method?: string; headers?: Record<string, string>; body?: string },
      ) => recorder.handleFetch(url, init),
    );
    await database.setup();
  });

  beforeEach(async () => {
    await database.reset();
  });

  afterAll(async () => {
    registerScenarioBenchmark("block-intervals", recorder.getBenchmarkSummary());
    await recorder.save();
    await database.teardown();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("runs each block source at its heights, after the prints of the block, and resumes without fetching blocks", async () => {
    const scenario = {
      database,
      contracts: [
        { contractId: SATOSHIBLES_CONTRACT, startBlock: CONTRACT_START, endBlock: CONTRACT_END },
      ],
      blocks: { Every7: EVERY_7, Every50: EVERY_50 },
    };

    const first = await runScenario(scenario);

    const heightsOf = (name: string) =>
      first.blockEvents.filter((event) => event.name === name).map((event) => event.blockHeight);

    expect(heightsOf("Every7")).toStrictEqual(EVERY_7_HEIGHTS);
    expect(heightsOf("Every50")).toStrictEqual(EVERY_50_HEIGHTS);
    expect(first.events).toHaveLength(7);
    first.tracer.assertChronologicalOrder();

    // Handlers run in height order across contracts and block sources; within
    // Block 47786 every print comes first, then the sources in definition order.
    const sequence = first.tracer.getSequence();
    const heights = sequence.map((entry) => entry.blockHeight);
    expect(heights).toStrictEqual([...heights].sort((left, right) => left - right));
    expect(sequence.filter((entry) => entry.blockHeight === 47786)).toStrictEqual([
      ...Array.from({ length: 4 }, () => ({
        type: "print",
        blockHeight: 47786,
        contractId: SATOSHIBLES_CONTRACT,
      })),
      { type: "block", blockHeight: 47786, name: "Every7" },
      { type: "block", blockHeight: 47786, name: "Every50" },
    ]);

    // Block events carry the real block, timed by its Bitcoin block.
    const blockEventsByKey = new Map(
      first.blockEvents.map((event) => [`${event.name}@${event.blockHeight}`, event]),
    );

    expect(blockEventsByKey.get("Every7@47786")).toStrictEqual({
      name: "Every7",
      blockHeight: 47786,
      ...BLOCK_47786,
    });
    expect(blockEventsByKey.get("Every7@47828")).toStrictEqual({
      name: "Every7",
      blockHeight: 47828,
      ...BLOCK_47828,
    });
    expect(blockEventsByKey.get("Every50@47786")).toStrictEqual({
      name: "Every50",
      blockHeight: 47786,
      ...BLOCK_47786,
    });
    expect(first.events[3].blockTime).toBe(BLOCK_47786.blockTime);

    expect(first.result.eventsProcessed).toBe(7 + EVERY_7_HEIGHTS.length + EVERY_50_HEIGHTS.length);
    expect(first.result.blocks).toStrictEqual({
      Every7: { eventsProcessed: EVERY_7_HEIGHTS.length, blockHeight: EVERY_7.endBlock },
      Every50: { eventsProcessed: EVERY_50_HEIGHTS.length, blockHeight: EVERY_50.endBlock },
    });
    expect(first.result.contracts[contractName(SATOSHIBLES_CONTRACT)]).toMatchObject({
      eventsProcessed: 7,
    });

    await expectBlockSourceProgress(database.db, "Every7", {
      syncedBlockHeight: EVERY_7.endBlock,
      isComplete: true,
    });
    await expectBlockSourceProgress(database.db, "Every50", {
      syncedBlockHeight: EVERY_50.endBlock,
      isComplete: true,
    });
    await expectTableCount(database.db, "block_sync_progress", 2);

    const storedHeights = [
      ...new Set([CONTRACT_START, ...EVERY_7_HEIGHTS, ...EVERY_50_HEIGHTS]),
    ].sort((left, right) => left - right);

    await expectStoredBlockHeights(database.db, storedHeights);

    // The second run on the same database delivers nothing and fetches no
    // Block: it only reads the chain tip and checks the first run's tip hash.
    const beforeRerun = recorder.getBenchmarkSummary();
    const second = await runScenario(scenario);

    expect(second.events).toHaveLength(0);
    expect(second.blockEvents).toHaveLength(0);
    expect(second.result.eventsProcessed).toBe(0);
    expect(requestsSince(beforeRerun, recorder.getBenchmarkSummary())).toStrictEqual({
      "GET /extended": 1,
      "GET /extended/v2/blocks/:height_or_hash": 1,
    });
    await expectStoredBlockHeights(database.db, storedHeights);

    assertBenchmarkSnapshot(recorder.getBenchmarkSummary());
  });
});
