import { eq } from "drizzle-orm";
import { Effect, Logger, References } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { IndexerDatabase } from "../database/index.ts";
import { StacksClient } from "../datasources/api/index.ts";
import { Indexing } from "../indexing/index.ts";
import { BlockHandlerExecutionError } from "../lib/errors.ts";
import type { BlockEvent, PrintEvent } from "../lib/types.ts";
import { syncStore } from "../sync-store/index.ts";
import { blocksTable, eventsTable, transactionsTable } from "../sync-store/schema.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { contractSpec, makeRuntime, type TestContract } from "../test-utils/historical-runtime.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import type { BlockSourceSpec } from "./blocks.ts";
import { indexEventsUpTo, prepareContracts } from "./historical.ts";

/** A block source handler failing with `failure` at `height`. */
const failAt = (height: number, failure: Error) => (event: BlockEvent) =>
  event.block.height === height ? Effect.fail(failure) : Effect.void;

describe("historical runtime with block sources", () => {
  const contractId = "SP123.token";
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;
  // oxlint-disable-next-line init-declarations
  let chain: FakeChain;
  /** When set, the chain tip read (`GET /extended`) fails with a 404. */
  let tipUnavailable = false;
  /** Handler runs in order: `print:<height>:<eventIndex>` or `<source>:<height>`. */
  let calls: string[] = [];
  /** Every block event handlers received, in order. */
  let received: BlockEvent[] = [];

  const blockSource = (
    name: string,
    range: Pick<BlockSourceSpec, "interval" | "startBlock" | "endBlock">,
  ): BlockSourceSpec => ({
    name,
    ...range,
    handler: (event: BlockEvent) =>
      Effect.sync(() => {
        calls.push(`${event.name}:${event.block.height}`);
        received.push(event);
      }),
  });

  const printHandler = (event: PrintEvent<unknown>) =>
    Effect.sync(() => {
      calls.push(`print:${event.block.height}:${event.eventIndex}`);
    });

  const mineTo = (height: number) => {
    while (chain.blocks[chain.blocks.length - 1].height < height) {
      chain.mine();
    }
  };

  /** Marks the contract synced below the first block, so `run` catches it up from the head. */
  const seedContractProgress = () =>
    testDb.run(
      syncStore.upsertSyncProgress({ contractId, chainId: 1, cursor: null, syncedBlockHeight: 99 }),
    );

  beforeAll(async () => {
    testDb = await createTestDatabase();
    // The HTTP client may keep the first `fetch` it sees; delegate to the current test's chain.
    vi.stubGlobal("fetch", (input: string | URL | Request) =>
      tipUnavailable &&
      new URL(input instanceof Request ? input.url : input).pathname === "/extended"
        ? Promise.resolve(new Response(JSON.stringify({ error: "down" }), { status: 404 }))
        : chain.fetch(input),
    );
  });

  beforeEach(async () => {
    await testDb.cleanup();
    calls = [];
    received = [];
    tipUnavailable = false;
    chain = createFakeChain({ baseHeight: 100 });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await testDb.close();
  });

  test("runs a blocks-only indexer at startBlock + k * interval up to endBlock or the tip", async () => {
    mineTo(160);

    const result = await makeRuntime({ db: testDb.db }).run(
      [],
      [
        blockSource("Every7", { interval: 7, startBlock: 103, endBlock: 150 }),
        blockSource("Every25", { interval: 25, startBlock: 100 }),
      ],
    );

    expect(calls).toStrictEqual([
      "Every25:100",
      "Every7:103",
      "Every7:110",
      "Every7:117",
      "Every7:124",
      "Every25:125",
      "Every7:131",
      "Every7:138",
      "Every7:145",
      "Every25:150",
    ]);
    // 131 comes from a blocks page, 145 from the single-block endpoint.
    expect(received.filter(({ block }) => [131, 145].includes(block.height))).toStrictEqual([
      {
        type: "block",
        name: "Every7",
        block: { height: 131, hash: "0x131", indexBlockHash: "index-0x131", time: 1310 },
      },
      {
        type: "block",
        name: "Every7",
        block: { height: 145, hash: "0x145", indexBlockHash: "index-0x145", time: 1450 },
      },
    ]);
    expect(result).toMatchObject({
      eventsProcessed: 10,
      blockHeight: 150,
      contracts: {},
      blocks: {
        Every7: { eventsProcessed: 7, blockHeight: 150 },
        Every25: { eventsProcessed: 3, blockHeight: 160 },
      },
    });
  });

  test("runs a block's prints first, then its sources in definition order", async () => {
    mineTo(119);
    chain.mine([
      {
        txId: "tx-120",
        events: [
          { contractId, eventIndex: 0 },
          { contractId, eventIndex: 1 },
        ],
      },
    ]);
    mineTo(140);
    await seedContractProgress();

    const result = await makeRuntime({ db: testDb.db }).run(
      [{ contractId, handler: printHandler }],
      [
        blockSource("Zeta", { interval: 20, startBlock: 100, endBlock: 140 }),
        blockSource("Alpha", { interval: 10, startBlock: 110, endBlock: 140 }),
      ],
    );

    expect(calls).toStrictEqual([
      "Zeta:100",
      "Alpha:110",
      "print:120:0",
      "print:120:1",
      "Zeta:120",
      "Alpha:120",
      "Alpha:130",
      "Zeta:140",
      "Alpha:140",
    ]);
    expect(result).toMatchObject({
      eventsProcessed: 9,
      contracts: { token: { eventsProcessed: 2 } },
      blocks: {
        Zeta: { eventsProcessed: 3, blockHeight: 140 },
        Alpha: { eventsProcessed: 4, blockHeight: 140 },
      },
    });
  });

  test("indexes nothing new on a second run over the same chain", async () => {
    mineTo(150);
    const sources = [blockSource("Every10", { interval: 10, startBlock: 100 })];
    const runtime = makeRuntime({ db: testDb.db });

    await runtime.run([], sources);
    calls = [];
    const requestsBefore = chain.requests.length;

    const second = await runtime.run([], sources);

    expect(calls).toStrictEqual([]);
    expect(second).toMatchObject({
      eventsProcessed: 0,
      blockHeight: 150,
      blocks: { Every10: { eventsProcessed: 0, blockHeight: 150 } },
    });
    // Only the chain tip read and the anchor check: no block is fetched again.
    expect(chain.requests.slice(requestsBefore)).toStrictEqual([
      "/extended",
      "/extended/v2/blocks/150",
    ]);
  });

  test("does not index past an incomplete source's synced height without a chain tip", async () => {
    mineTo(130);
    await seedContractProgress();
    const contracts = [{ contractId, handler: printHandler }];
    const sources = [blockSource("Every10", { interval: 10, startBlock: 100 })];
    // Finality 0: the tipless run drops the anchor, and the next run replays
    // Everything above the finalized height; keep that range empty.
    const runtime = makeRuntime({ db: testDb.db, finality: 0 });

    await runtime.run(contracts, sources);

    expect(calls).toStrictEqual(["Every10:100", "Every10:110", "Every10:120", "Every10:130"]);

    // The contract prints at 170 while the tip cannot be read.
    mineTo(169);
    chain.mine([{ txId: "tx-170", events: [{ contractId, eventIndex: 0 }] }]);
    mineTo(180);
    calls = [];
    tipUnavailable = true;

    const blind = await runtime.run(contracts, sources);

    // The print at 170 is stored but stays unindexed: the source never synced past 130.
    expect(calls).toStrictEqual([]);
    expect(blind).toMatchObject({
      eventsProcessed: 0,
      blockHeight: 130,
      blocks: { Every10: { eventsProcessed: 0, blockHeight: 130 } },
    });

    tipUnavailable = false;
    const caughtUp = await runtime.run(contracts, sources);

    expect(calls).toStrictEqual([
      "Every10:140",
      "Every10:150",
      "Every10:160",
      "print:170:0",
      "Every10:170",
      "Every10:180",
    ]);
    expect(caughtUp).toMatchObject({
      eventsProcessed: 6,
      blockHeight: 180,
      contracts: { token: { eventsProcessed: 1 } },
      blocks: { Every10: { eventsProcessed: 5, blockHeight: 180 } },
    });
  });

  describe("indexing in pages", () => {
    /** Stores blocks 100 to 115 and, per transaction, `count` prints of the contract. */
    const seedRows = async (
      transactions: readonly { txId: string; height: number; txIndex: number; count: number }[],
    ) => {
      await testDb.db.insert(blocksTable).values(
        Array.from({ length: 16 }, (_, index) => {
          const height = 100 + index;

          return {
            chainId: 1n,
            height: BigInt(height),
            hash: `0x${height}`,
            indexBlockHash: `index-0x${height}`,
            blockTime: BigInt(height * 10),
            tenureHeight: BigInt(height),
          };
        }),
      );

      if (transactions.length === 0) {
        return;
      }

      await testDb.db.insert(transactionsTable).values(
        transactions.map(({ txId, height, txIndex }) => ({
          chainId: 1n,
          txId,
          blockHeight: BigInt(height),
          blockHash: `0x${height}`,
          txIndex,
          txType: "contract_call",
          senderAddress: "SP sender",
          feeRate: 1000n,
          nonce: 0n,
          txStatus: "success",
        })),
      );
      await testDb.db.insert(eventsTable).values(
        transactions.flatMap(({ txId, height, count }) =>
          Array.from({ length: count }, (_, eventIndex) => ({
            chainId: 1n,
            contractId,
            txId,
            eventIndex,
            eventType: "smart_contract_log",
            topic: "print",
            valueHex: "0x0703",
            valueRepr: "(ok true)",
            blockHeight: BigInt(height),
          })),
        ),
      );
    };

    /** Indexes the stored rows up to `toBlockHeight`, reading `pageRows` rows of each kind per page. */
    const indexTo = (options: {
      readonly toBlockHeight: number;
      readonly pageRows: number;
      readonly contracts: readonly TestContract[];
      readonly blocks: readonly BlockSourceSpec[];
    }) =>
      testDb.run(
        Effect.gen(function* () {
          const prepared = yield* prepareContracts(
            options.contracts.map(contractSpec),
            options.blocks,
          );

          const eventsByName = new Map<string, number>();

          yield* indexEventsUpTo(
            options.toBlockHeight,
            prepared,
            1,
            eventsByName,
            0,
            115,
            options.pageRows,
          ).pipe(
            Effect.provide(
              Indexing.layer({ contracts: prepared.contracts, blocks: prepared.blocks }),
            ),
          );

          return eventsByName;
        }).pipe(
          Effect.provide(StacksClient.layer({ baseUrl: "http://stacks.test" })),
          Effect.provideService(References.MinimumLogLevel, "None"),
        ),
      );

    test("handles every row once, in order, with pages smaller than a block", async () => {
      await seedRows([
        { txId: "tx-101", height: 101, txIndex: 0, count: 1 },
        // Block 103 holds more prints than a page.
        { txId: "tx-103-a", height: 103, txIndex: 0, count: 3 },
        { txId: "tx-103-b", height: 103, txIndex: 1, count: 2 },
        { txId: "tx-104", height: 104, txIndex: 0, count: 2 },
        { txId: "tx-112", height: 112, txIndex: 0, count: 1 },
        // Above the indexed range.
        { txId: "tx-114", height: 114, txIndex: 0, count: 1 },
      ]);

      const eventsByName = await indexTo({
        toBlockHeight: 113,
        pageRows: 2,
        contracts: [
          {
            contractId,
            handler: (event) =>
              Effect.sync(() => {
                calls.push(`print:${event.block.height}:${event.txId}:${event.eventIndex}`);
              }),
          },
        ],
        blocks: [
          // 105 to 110 run without a print in between.
          blockSource("Dense", { interval: 1, startBlock: 100, endBlock: 110 }),
          blockSource("Sparse", { interval: 4, startBlock: 102 }),
        ],
      });

      expect(calls).toStrictEqual([
        "Dense:100",
        "print:101:tx-101:0",
        "Dense:101",
        "Dense:102",
        "Sparse:102",
        "print:103:tx-103-a:0",
        "print:103:tx-103-a:1",
        "print:103:tx-103-a:2",
        "print:103:tx-103-b:0",
        "print:103:tx-103-b:1",
        "Dense:103",
        "print:104:tx-104:0",
        "print:104:tx-104:1",
        "Dense:104",
        "Dense:105",
        "Dense:106",
        "Sparse:106",
        "Dense:107",
        "Dense:108",
        "Dense:109",
        "Dense:110",
        "Sparse:110",
        "print:112:tx-112:0",
      ]);
      expect(eventsByName).toStrictEqual(
        new Map([
          ["token", 9],
          ["Dense", 11],
          ["Sparse", 3],
        ]),
      );
      await expect(testDb.run(syncStore.getCheckpoint({ chainId: 1 }))).resolves.toMatchObject({
        blockHeight: 112n,
      });
    });

    test("handles a run of more source blocks than a page without prints", async () => {
      await seedRows([]);

      const eventsByName = await indexTo({
        toBlockHeight: 115,
        pageRows: 2,
        contracts: [],
        blocks: [blockSource("Every3", { interval: 3, startBlock: 100 })],
      });

      expect(calls).toStrictEqual([
        "Every3:100",
        "Every3:103",
        "Every3:106",
        "Every3:109",
        "Every3:112",
        "Every3:115",
      ]);
      expect(eventsByName).toStrictEqual(new Map([["Every3", 6]]));
      await expect(testDb.run(syncStore.getCheckpoint({ chainId: 1 }))).resolves.toMatchObject({
        blockHeight: 115n,
      });
    });
  });

  describe("history skipped by a source added after indexing", () => {
    let messages: string[] = [];

    const logger = Logger.make((options) => {
      messages.push(String(Logger.formatStructured.log(options).message));
    });

    /** Each skipped-history warning, cut to the length of the prefix expected at its position. */
    const skippedHistoryWarnings = (prefixes: readonly string[]) =>
      messages
        .filter((message) => message.includes(" has no sync progress"))
        .map((message, index) => message.slice(0, prefixes[index]?.length));

    const runtime = () => makeRuntime({ db: testDb.db, logger });

    beforeEach(() => {
      messages = [];
    });

    test("does not warn on a first run or for a resumed source", async () => {
      mineTo(150);
      const sources = [blockSource("Every10", { interval: 10, startBlock: 100 })];

      await runtime().run([], sources);
      mineTo(160);
      calls = [];
      await runtime().run([], sources);

      expect(calls).toStrictEqual(["Every10:160"]);
      expect(skippedHistoryWarnings([])).toStrictEqual([]);
    });

    test("warns about a block source added with a start at or below the checkpoint", async () => {
      mineTo(150);
      const every10 = blockSource("Every10", { interval: 10, startBlock: 100 });

      await runtime().run([], [every10]);
      mineTo(170);
      calls = [];

      await runtime().run(
        [],
        [
          every10,
          blockSource("Added", { interval: 5, startBlock: 100, endBlock: 120 }),
          // Starts above the checkpoint: nothing is skipped.
          blockSource("Later", { interval: 5, startBlock: 160 }),
        ],
      );

      const expected = [
        "blocks.Added has no sync progress for its interval and startBlock, but indexing is already at block 150: it will not run at blocks 100 to 120.",
      ];

      expect(skippedHistoryWarnings(expected)).toStrictEqual(expected);
      expect(calls).toStrictEqual([
        "Every10:160",
        "Later:160",
        "Later:165",
        "Every10:170",
        "Later:170",
      ]);
    });

    test("warns when a block source's interval changes", async () => {
      mineTo(150);

      await runtime().run([], [blockSource("Every10", { interval: 10, startBlock: 100 })]);
      mineTo(160);
      calls = [];

      await runtime().run([], [blockSource("Every10", { interval: 20, startBlock: 100 })]);

      const expected = [
        "blocks.Every10 has no sync progress for its interval and startBlock, but indexing is already at block 150: it will not run at blocks 100 to 150.",
      ];

      expect(skippedHistoryWarnings(expected)).toStrictEqual(expected);
      // 120 and 140 are at or below the checkpoint.
      expect(calls).toStrictEqual(["Every10:160"]);
    });

    test("warns about a contract added at or below the checkpoint", async () => {
      mineTo(150);
      const sources = [blockSource("Every10", { interval: 10, startBlock: 100 })];

      await runtime().run([], sources);
      mineTo(160);

      await runtime().run(
        [
          { contractId, handler: printHandler },
          // Starts above the checkpoint: nothing is skipped.
          { contractId: "SP123.later", handler: printHandler, startBlock: 155 },
        ],
        sources,
      );

      const expected = [
        "contracts.token has no sync progress, but indexing is already at block 150",
      ];

      expect(skippedHistoryWarnings(expected)).toStrictEqual(expected);
    });
  });

  test("fails with BlockHandlerExecutionError and rolls back the failing block", async () => {
    const failure = new Error("boom");
    mineTo(120);

    const sources: BlockSourceSpec[] = [
      {
        name: "Writer",
        interval: 10,
        startBlock: 100,
        handler: (event) =>
          Effect.gen(function* () {
            const db = yield* IndexerDatabase;

            yield* db.insert(blocksTable).values({
              chainId: 2n,
              height: BigInt(event.block.height),
              hash: `marker-${event.block.height}`,
              indexBlockHash: `index-marker-${event.block.height}`,
              blockTime: 0n,
              tenureHeight: 0n,
            });
          }),
      },
      { name: "Failing", interval: 10, startBlock: 100, handler: failAt(130, failure) },
    ];

    const runtime = makeRuntime({ db: testDb.db });

    await runtime.run([], sources);
    mineTo(140);

    const run = runtime.run([], sources);

    await expect(run).rejects.toBeInstanceOf(BlockHandlerExecutionError);
    await expect(run).rejects.toMatchObject({ name: "Failing", blockHeight: 130, cause: failure });
    // Writer's run at 130 is rolled back with the batch; the checkpoint stays at the previous one.
    // Handler writes go to chain 2's blocks, which the runtime on chain 1 never touches.
    await expect(
      testDb.db
        .select({ height: blocksTable.height })
        .from(blocksTable)
        .where(eq(blocksTable.chainId, 2n))
        .orderBy(blocksTable.height),
    ).resolves.toStrictEqual([{ height: 100n }, { height: 110n }, { height: 120n }]);
    await expect(testDb.run(syncStore.getCheckpoint({ chainId: 1 }))).resolves.toMatchObject({
      blockHeight: 120n,
    });
  });
});
