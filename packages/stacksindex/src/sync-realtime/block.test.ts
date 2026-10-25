import { Effect, Layer, References, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { IndexerDatabase } from "../database/index.ts";
import { toLightBlock } from "../datasources/api/heads.ts";
import { StacksClient } from "../datasources/api/index.ts";
import { syncStore } from "../sync-store/index.ts";
import { blocksTable, eventsTable, transactionsTable } from "../sync-store/schema.ts";
import { Sync, type SyncFilter } from "../sync/index.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { estimateBlockRequests, syncBlock } from "./block.ts";

const BASE_HEIGHT = 100;

const TOKEN = "SP1.token";

const POOL = "SP1.pool";

const LATE = "SP1.late";

const FILTERS: readonly SyncFilter[] = [
  { name: "token", contractId: TOKEN },
  { name: "pool", contractId: POOL, endBlock: 102 },
  { name: "late", contractId: LATE, startBlock: 103 },
];

/** Blocks covering what both fetch paths must agree on. */
const mineScenario = (chain: FakeChain) => {
  chain.mine([
    // Logs of two watched contracts and an unwatched one in one transaction.
    {
      txId: "tx-101-a",
      events: [
        { contractId: TOKEN, eventIndex: 0, repr: "(token 1)" },
        { contractId: POOL, eventIndex: 1 },
        { contractId: "SP9.unwatched", eventIndex: 2 },
      ],
    },
    // Aborted: no events anywhere.
    {
      txId: "tx-101-failed",
      status: "abort_by_response",
      events: [{ contractId: TOKEN, eventIndex: 0 }],
    },
    { txId: "tx-101-transfer", assetEvents: 2, events: [] },
  ]);
  chain.mine();
  // Logs beyond the first events page.
  chain.mine([
    {
      txId: "tx-103",
      assetEvents: 150,
      events: [
        { contractId: TOKEN, eventIndex: 150 },
        // Past the pool's end block.
        { contractId: POOL, eventIndex: 151 },
        { contractId: LATE, eventIndex: 152 },
      ],
    },
  ]);
};

describe("per-block sync", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;
  // oxlint-disable-next-line init-declarations
  let chain: FakeChain;

  const run = <A, E>(effect: Effect.Effect<A, E, StacksClient | IndexerDatabase | Sync>) =>
    testDb.run(
      effect.pipe(
        Effect.provide(
          Layer.provideMerge(
            Sync.layer({ chainId: 1 }),
            StacksClient.layer({ baseUrl: "https://api.example.com" }),
          ),
        ),
        Effect.provideService(IndexerDatabase, testDb.db),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

  const seedProgress = async () => {
    for (const filter of FILTERS) {
      await testDb.run(
        syncStore.upsertSyncProgress({
          contractId: filter.contractId,
          chainId: 1,
          cursor: null,
          syncedBlockHeight: BASE_HEIGHT,
        }),
      );
    }
  };

  /**
   * Stored rows, keeping only events inside their filter's block range: the
   * contract logs sync may also store a page's events past `endBlock`, which
   * indexing skips.
   */
  const storedRows = async () => {
    const events = await testDb.db
      .select()
      .from(eventsTable)
      .orderBy(eventsTable.blockHeight, eventsTable.txId, eventsTable.eventIndex);

    return {
      blocks: await testDb.db.select().from(blocksTable).orderBy(blocksTable.height),
      transactions: await testDb.db
        .select()
        .from(transactionsTable)
        .orderBy(transactionsTable.txId),
      events: events.filter((event) => {
        const filter = FILTERS.find((candidate) => candidate.contractId === event.contractId);
        const height = Number(event.blockHeight);

        return (filter?.startBlock ?? 0) <= height && height <= (filter?.endBlock ?? Infinity);
      }),
    };
  };

  beforeAll(async () => {
    testDb = await createTestDatabase();
    vi.stubGlobal("fetch", (input: string | URL | Request) => chain.fetch(input));
  });

  beforeEach(async () => {
    await testDb.cleanup();
    chain = createFakeChain({ baseHeight: BASE_HEIGHT });
    mineScenario(chain);
  });

  afterAll(async () => {
    await testDb.close();
  });

  test("stores the same rows as the contract logs sync", async () => {
    await seedProgress();
    await run(
      Effect.gen(function* () {
        const sync = yield* Sync;

        yield* Stream.runDrain(sync.historical(FILTERS));
      }),
    );

    const fromContractLogs = await storedRows();

    await testDb.cleanup();
    await seedProgress();

    for (const block of chain.blocks.filter((candidate) => candidate.height > BASE_HEIGHT)) {
      await run(
        syncBlock({
          chainId: 1,
          filters: FILTERS,
          block: toLightBlock({
            height: block.height,
            hash: block.hash,
            parent_block_hash: block.parentHash,
            block_time: block.blockTime,
            tenure_height: block.height,
            txs: block.transactions.map((transaction) => transaction.txId),
          }),
        }),
      );
    }

    const fromBlocks = await storedRows();

    expect(fromBlocks).toStrictEqual(fromContractLogs);
    expect(fromBlocks.events.map((event) => [event.contractId, event.txId])).toStrictEqual([
      [TOKEN, "tx-101-a"],
      [POOL, "tx-101-a"],
      [TOKEN, "tx-103"],
      [LATE, "tx-103"],
    ]);
  });

  test("marks every syncing contract synced through the block", async () => {
    await seedProgress();

    const [block101, block102] = chain.blocks.filter((block) => block.height > BASE_HEIGHT);

    for (const block of [block101, block102]) {
      await run(
        syncBlock({
          chainId: 1,
          filters: FILTERS,
          block: toLightBlock({
            height: block.height,
            hash: block.hash,
            parent_block_hash: block.parentHash,
            block_time: block.blockTime,
            tenure_height: block.height,
            txs: block.transactions.map((transaction) => transaction.txId),
          }),
        }),
      );
    }

    const syncedHeights = await Promise.all(
      FILTERS.map(async (filter) => {
        const progress = await testDb.run(
          syncStore.getSyncProgress({ chainId: 1, contractId: filter.contractId }),
        );

        return [filter.contractId, Number(progress?.syncedBlockHeight)];
      }),
    );

    // The late contract only starts at 103, so nothing below it moves.
    expect(syncedHeights).toStrictEqual([
      [TOKEN, 102],
      [POOL, 102],
      [LATE, BASE_HEIGHT],
    ]);
  });

  test("fetches events only for successful transactions that may hold logs", async () => {
    await seedProgress();
    chain.mine([
      { txId: "tx-104-tenure", type: "tenure_change", events: [] },
      // Mint events and an STX transfer event: never a print.
      { txId: "tx-104-coinbase", type: "coinbase", assetEvents: 1, events: [] },
      { txId: "tx-104-transfer", type: "token_transfer", assetEvents: 1, events: [] },
      { txId: "tx-104-empty", events: [] },
      { txId: "tx-104-failed", status: "abort_by_response", events: [] },
      { txId: "tx-104-log", events: [{ contractId: TOKEN, eventIndex: 0 }] },
    ]);

    const [block] = chain.blocks.slice(-1);

    const stored = await run(
      syncBlock({
        chainId: 1,
        filters: FILTERS,
        block: toLightBlock({
          height: block.height,
          hash: block.hash,
          parent_block_hash: block.parentHash,
          block_time: block.blockTime,
          tenure_height: block.height,
          txs: block.transactions.map((transaction) => transaction.txId),
        }),
      }),
    );

    const eventsRequests = chain.requests.filter((request) =>
      /^\/extended\/v3\/transactions\/[^/]+\/events/u.test(request),
    );

    expect(stored).toBe(1);
    expect(eventsRequests).toStrictEqual(["/extended/v3/transactions/tx-104-log/events?limit=100"]);
  });

  test("estimates one transactions page plus one events page per transaction", () => {
    const block = { height: 1, hash: "0x1", parentHash: "0x0", blockTime: 1, tenureHeight: 1 };

    expect(estimateBlockRequests({ ...block, txCount: 0 })).toBe(1);
    expect(estimateBlockRequests({ ...block, txCount: 50 })).toBe(51);
    expect(estimateBlockRequests({ ...block, txCount: 51 })).toBe(53);
  });
});
