// oxlint-disable typescript/no-unsafe-assignment

import { eq } from "drizzle-orm";
import { Deferred, Effect, Fiber, Logger, Metric, References, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { StacksClient, type StacksClientService } from "../datasources/api/index.ts";
import { syncBlock, syncErrors, syncEvents, syncPages } from "../lib/metrics.ts";
import { syncStore } from "../sync-store/index.ts";
import { blocksTable } from "../sync-store/schema.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { type BlockSyncFilter, createSync, type SyncEvent, type SyncFilter } from "./index.ts";

const CHAIN_ID = 1;

const CONTRACT_ID = "SP123.token";

interface ChainEvent {
  readonly txId: string;
  readonly height: number;
}

const cursorOf = (event: ChainEvent) => `${event.height}:0:0:0`;

const transaction = (txId: string, height: number) => ({
  tx_id: txId,
  sender: { address: "SP sender", nonce: 0 },
  fee_rate: "1000",
  block: {
    height,
    hash: `block-${height}`,
    index_hash: `index-block-${height}`,
    tx_index: 0,
    time: height * 10,
  },
  bitcoin_block: { height, time: height * 10 },
  status: "success",
  type: "contract_call",
});

const logEvent = (event: ChainEvent) => ({
  tx_id: event.txId,
  event_index: 0,
  event_type: "smart_contract_log",
  contract_log: {
    contract_id: CONTRACT_ID,
    topic: "print",
    value: { hex: "0x01", repr: "(ok true)" },
  },
});

/** One log event per block at each height, named `tx-<height>`. */
const chainAt = (heights: number[]): ChainEvent[] =>
  heights.map((height) => ({ txId: `tx-${height}`, height }));

/**
 * Mirrors `GET /extended/v2/smart-contracts/{id}/logs` (stacks-blockchain-api
 * `getSmartContractLogs`): newest first, `cursor` selects events at or below
 * it, `next_cursor` is the event a full page newer than the top (null when no
 * full page of newer events exists) and `prev_cursor` the newest event of the
 * next older page.
 */
const logsPage = (chain: readonly ChainEvent[], limit: number, cursor: string | undefined) => {
  const cursorHeight =
    cursor === undefined ? Number.MAX_SAFE_INTEGER : Number(cursor.split(":")[0]);

  const topIndex = chain.findLastIndex((event) => event.height <= cursorHeight);
  const selected = chain.slice(Math.max(topIndex - limit + 1, 0), topIndex + 1).reverse();
  const next = chain[topIndex + limit];
  const prev = topIndex >= limit ? chain[topIndex - limit] : undefined;

  return {
    limit,
    offset: 0,
    total: chain.length,
    cursor: topIndex === -1 ? null : cursorOf(chain[topIndex]),
    next_cursor: topIndex === -1 || next === undefined ? null : cursorOf(next),
    prev_cursor: prev === undefined ? null : cursorOf(prev),
    results: selected.map(logEvent),
  };
};

const notUsed = () => Effect.die("StacksClient method not used in this test");

interface FakeApi {
  readonly client: StacksClientService;
  readonly logRequests: (string | undefined)[];
  readonly batchRequests: string[][];
}

/** Fake Stacks API serving `chain` with `limit` events per logs page. */
const makeFakeApi = (chain: readonly ChainEvent[], limit = 2): FakeApi => {
  const logRequests: (string | undefined)[] = [];
  const batchRequests: string[][] = [];
  const heightByTxId = new Map(chain.map((event) => [event.txId, event.height]));

  return {
    logRequests,
    batchRequests,
    client: {
      getStatus: notUsed,
      getBlocks: notUsed,
      getBlock: notUsed,
      getStacksBlocks: notUsed,
      getBitcoinBlocks: notUsed,
      getBlockTransactions: notUsed,
      getV1Transaction: notUsed,
      getTransactionsBatch: (txIds: string[]) => {
        batchRequests.push(txIds);

        // SAFETY: `transaction` builds the batch summary fields the sync reads; `never` satisfies the expected success type.
        return Effect.succeed({
          results: txIds.map((txId) => transaction(txId, heightByTxId.get(txId) ?? 0)),
        } as never);
      },
      getTransactionEvents: notUsed,
      getPrincipalTransactions: notUsed,
      getContract: notUsed,
      getContractLogs: (_contractId: string, options?: { cursor?: string }) => {
        logRequests.push(options?.cursor);

        // SAFETY: `logsPage` builds the logs endpoint response shape; `never` satisfies the expected success type.
        return Effect.succeed(logsPage(chain, limit, options?.cursor) as never);
      },
      callReadFunction: notUsed,
    },
  };
};

/**
 * Fake API whose cursor discovery finds `first` as the first event. Each
 * response carries only the fields `getContractEventsFirstCursor` reads.
 */
const withDiscovery = (api: FakeApi, first: ChainEvent): StacksClientService => ({
  ...api.client,
  // SAFETY: Discovery reads only `block.height` from the contract.
  getContract: () => Effect.succeed({ block: { height: first.height } } as never),
  getPrincipalTransactions: () =>
    // SAFETY: Discovery reads only `results[].transaction` and `cursor.previous`.
    Effect.succeed({
      results: [
        {
          transaction: {
            tx_id: first.txId,
            event_count: 1,
            block: { height: first.height, tx_index: 0 },
            bitcoin_block: { height: first.height },
          },
        },
      ],
      cursor: { previous: null },
    } as never),
  getTransactionEvents: () =>
    // SAFETY: Discovery reads only `results[]` contract logs and `cursor.next`.
    Effect.succeed({
      results: [
        { type: "contract_log", event_index: 0, contract_log: { contract_id: CONTRACT_ID } },
      ],
      cursor: { next: null },
    } as never),
  // SAFETY: Discovery reads only `microblock_sequence`.
  getV1Transaction: () => Effect.succeed({ microblock_sequence: 0 } as never),
});

/** Delays forward-page fetches by 11 seconds, signalling `fetchStarted` first. */
const withSlowForwardPages = (
  api: FakeApi,
  fetchStarted: Deferred.Deferred<"fetch-started">,
): StacksClientService => ({
  ...api.client,
  getContractLogs: (contractId, options) =>
    options?.cursor === undefined
      ? api.client.getContractLogs(contractId, options)
      : Deferred.succeed(fetchStarted, "fetch-started").pipe(
          Effect.andThen(Effect.sleep("11 seconds")),
          Effect.andThen(api.client.getContractLogs(contractId, options)),
        ),
});

interface CapturedLog {
  level: string;
  message: unknown;
  annotations: Record<string, string | number | boolean>;
}

const captureLogs = (logs: CapturedLog[]) =>
  Logger.make((options) => {
    const output = Logger.formatStructured.log(options);

    logs.push({
      level: output.level,
      message: output.message,
      // SAFETY: `formatStructured` exposes annotations as an untyped record; these tests read known keys.
      annotations: output.annotations as Record<string, string | number | boolean>,
    });
  });

describe("sync historical", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  beforeEach(async () => {
    await testDb.cleanup();
  });

  afterAll(async () => {
    await testDb.close();
  });

  const seedProgress = (
    cursor: string | null,
    syncedBlockHeight: number,
    contractId = CONTRACT_ID,
  ) =>
    testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: CHAIN_ID,
        cursor,
        syncedBlockHeight,
      }),
    );

  const runSync = (
    client: StacksClientService,
    filters: SyncFilter[] = [{ name: "token", contractId: CONTRACT_ID }],
  ) =>
    Effect.runPromise(
      createSync({ chainId: CHAIN_ID, client, database: testDb.db })
        .historical(filters)
        .pipe(Stream.runCollect, Effect.provideService(References.MinimumLogLevel, "None")),
    );

  const storedEventHeights = async () =>
    (await testDb.run(syncStore.getEvents({ chainId: CHAIN_ID, fromBlockHeight: 0 }))).map(
      (event) => Number(event.blockHeight),
    );

  const getProgress = () =>
    testDb.run(syncStore.getSyncProgress({ contractId: CONTRACT_ID, chainId: CHAIN_ID }));

  test("streams started, safe and completed while persisting fetched data", async () => {
    const api = makeFakeApi(chainAt([100, 200]), 1);
    await seedProgress("100:0:0:0", 99);

    const events = await runSync(api.client);

    expect(events.map((event) => event.type)).toStrictEqual([
      "started",
      "safe",
      "safe",
      "completed",
    ]);
    expect(events[0]).toMatchObject({
      type: "started",
      contracts: [{ contractId: CONTRACT_ID, doneAtStart: false }],
    });
    expect(events[1]).toMatchObject({
      type: "safe",
      safeBlockHeight: 99,
      contracts: [
        {
          contractId: CONTRACT_ID,
          doneAtStart: false,
          lastBlockHeight: 99,
          initialBlockHeight: 99,
          pagesFetched: 1,
          transactionsFetched: 1,
          eventsStored: 1,
        },
      ],
    });
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      contracts: [{ contractId: CONTRACT_ID, doneAtStart: false, lastBlockHeight: 200 }],
    });
    await expect(storedEventHeights()).resolves.toStrictEqual([100, 200]);
    await expect(getProgress()).resolves.toMatchObject({
      cursor: null,
      syncedBlockHeight: 200n,
      isComplete: false,
    });
  });

  test("fetches events newer than the last full forward page", async () => {
    // With two events per page, the page at 300 has no `next_cursor` because
    // Only one newer event (400) exists. Forward pagination alone stops there.
    const api = makeFakeApi(chainAt([100, 200, 300, 400]), 2);
    await seedProgress("100:0:0:0", 99);

    const events = await runSync(api.client);

    await expect(storedEventHeights()).resolves.toStrictEqual([100, 200, 300, 400]);
    expect(api.logRequests).toStrictEqual(["100:0:0:0", "300:0:0:0", undefined]);
    expect(events.at(-1)).toMatchObject({
      type: "completed",
      contracts: [{ lastBlockHeight: 400 }],
    });
    await expect(getProgress()).resolves.toMatchObject({ cursor: null, syncedBlockHeight: 400n });
  });

  test("checks a caught-up contract with a single request", async () => {
    const api = makeFakeApi(chainAt([100, 200]));
    await seedProgress(null, 200);

    const events = await runSync(api.client);

    expect(api.logRequests).toStrictEqual([undefined]);
    expect(api.batchRequests).toStrictEqual([]);
    expect(events.map((event) => event.type)).toStrictEqual(["started", "completed"]);
    expect(events.at(-1)).toMatchObject({
      contracts: [{ doneAtStart: true, lastBlockHeight: 200, pagesFetched: 1 }],
    });
  });

  test("catches up new events across pages oldest first", async () => {
    const api = makeFakeApi(chainAt([100, 200, 300, 400, 500, 600]), 2);
    await seedProgress(null, 200);
    await testDb.run(
      syncStore.insertTransactions({
        transactions: [transaction("tx-200", 200)],
        chainId: CHAIN_ID,
      }),
    );

    const events = await runSync(api.client);

    // Pages [600, 500], [400, 300], then stop: the next older page tops at 200.
    expect(api.logRequests).toStrictEqual([undefined, "400:0:0:0"]);
    expect(api.batchRequests.flat()).toStrictEqual(["tx-300", "tx-400", "tx-500", "tx-600"]);
    await expect(storedEventHeights()).resolves.toStrictEqual([300, 400, 500, 600]);
    expect(events.filter((event) => event.type === "safe")).toMatchObject([
      { safeBlockHeight: 399 },
    ]);
    expect(events.at(-1)).toMatchObject({
      contracts: [{ doneAtStart: false, lastBlockHeight: 600 }],
    });
    await expect(getProgress()).resolves.toMatchObject({ cursor: null, syncedBlockHeight: 600n });
  });

  test("resumes forward sync when the catch-up backlog exceeds the page budget", async () => {
    const heights = Array.from({ length: 12 }, (_, index) => 200 + index * 100);
    const chain = chainAt([100, ...heights]);
    const api = makeFakeApi(chain, 1);
    await seedProgress(null, 100);

    await runSync(withDiscovery(api, chain[1]));

    await expect(storedEventHeights()).resolves.toStrictEqual(heights);
    // Ten buffered catch-up pages are dropped, then pagination runs forward
    // From the discovered cursor and finishes from the head.
    expect(api.logRequests.slice(10, 12)).toStrictEqual(["200:0:0:0", "300:0:0:0"]);
    expect(api.logRequests.at(-1)).toBeUndefined();
    await expect(getProgress()).resolves.toMatchObject({ cursor: null, syncedBlockHeight: 1300n });
  });

  test("completes at endBlock while catching up", async () => {
    const api = makeFakeApi(chainAt([100, 200, 300, 400]), 2);
    await seedProgress(null, 100);

    const events = await runSync(api.client, [
      { name: "token", contractId: CONTRACT_ID, endBlock: 300 },
    ]);

    // The oldest page overlaps the synced range (100); nothing past endBlock is stored.
    await expect(storedEventHeights()).resolves.toStrictEqual([100, 200, 300]);
    expect(events.at(-1)).toMatchObject({ contracts: [{ lastBlockHeight: 300 }] });
    await expect(getProgress()).resolves.toMatchObject({
      cursor: null,
      syncedBlockHeight: 300n,
      isComplete: true,
    });
  });

  test("completes at endBlock while paginating forward", async () => {
    const api = makeFakeApi(chainAt([100, 200, 300, 400, 500, 600]), 2);
    await seedProgress("100:0:0:0", 99);

    const events = await runSync(api.client, [
      { name: "token", contractId: CONTRACT_ID, endBlock: 250 },
    ]);

    expect(api.logRequests).toStrictEqual(["100:0:0:0", "300:0:0:0"]);
    expect(events.at(-1)).toMatchObject({ contracts: [{ lastBlockHeight: 250 }] });
    await expect(getProgress()).resolves.toMatchObject({
      cursor: null,
      syncedBlockHeight: 250n,
      isComplete: true,
    });
  });

  test("reports done contracts without limiting the safe height of active ones", async () => {
    const activeContractId = "SP123.active";
    const api = makeFakeApi(chainAt([100, 400]), 1);
    await seedProgress(null, 400);
    await seedProgress("100:0:0:0", 99, activeContractId);

    const events = await runSync(api.client, [
      { name: "token", contractId: CONTRACT_ID },
      { name: "active", contractId: activeContractId },
    ]);

    expect(events[1]).toMatchObject({
      type: "safe",
      safeBlockHeight: 99,
      contracts: [
        { contractId: CONTRACT_ID, doneAtStart: true, lastBlockHeight: 400 },
        { contractId: activeContractId, lastBlockHeight: 99 },
      ],
    });
  });

  test("bounds fetching while the consumer is busy", async () => {
    await seedProgress("100:0:0:0", 99);

    let pageCalls = 0;
    const api = makeFakeApi(chainAt([100, 200]), 1);

    // Always returns the same page so an unbounded producer would loop forever.
    const client: StacksClientService = {
      ...api.client,
      getContractLogs: () => {
        pageCalls += 1;

        // SAFETY: `logsPage` builds the logs endpoint response shape; `never` satisfies the expected success type.
        return Effect.succeed(logsPage(chainAt([100, 200]), 1, "100:0:0:0") as never);
      },
    };

    const sync = createSync({ chainId: CHAIN_ID, client, database: testDb.db });

    // The consumer blocks on the first event, so the producer should only be
    // Able to run ahead by the queue capacity.
    const fiber = Effect.runFork(
      sync.historical([{ name: "token", contractId: CONTRACT_ID }]).pipe(
        Stream.runForEach(() => Effect.sleep("10 seconds")),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

    await Effect.runPromise(Effect.sleep("100 millis"));
    const callsWhileBlocked = pageCalls;
    await Effect.runPromise(Fiber.interrupt(fiber));

    expect(callsWhileBlocked).toBeGreaterThanOrEqual(1);
    expect(callsWhileBlocked).toBeLessThanOrEqual(3);
  });

  test("records sync metrics", async () => {
    await seedProgress("100:0:0:0", 99);

    const sync = createSync({
      chainId: CHAIN_ID,
      client: makeFakeApi(chainAt([100, 200]), 1).client,
      database: testDb.db,
    });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* sync
          .historical([{ name: "token", contractId: CONTRACT_ID }])
          .pipe(Stream.runCollect);

        const backfillPages = yield* Metric.value(
          Metric.withAttributes(syncPages, {
            contract: "token",
            contract_id: CONTRACT_ID,
            kind: "backfill",
          }),
        );

        const catchupPages = yield* Metric.value(
          Metric.withAttributes(syncPages, {
            contract: "token",
            contract_id: CONTRACT_ID,
            kind: "catchup",
          }),
        );

        const storedEvents = yield* Metric.value(
          Metric.withAttributes(syncEvents, {
            contract: "token",
            contract_id: CONTRACT_ID,
            path: "historical",
          }),
        );

        const block = yield* Metric.value(
          Metric.withAttributes(syncBlock, { contract: "token", contract_id: CONTRACT_ID }),
        );

        return {
          events,
          backfillPages: backfillPages.count,
          catchupPages: catchupPages.count,
          storedEvents: storedEvents.count,
          block: block.value,
        };
      }).pipe(
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

    // Two forward pages, then the head page that confirms the newest event.
    expect(result.backfillPages).toBe(2);
    expect(result.catchupPages).toBe(1);
    expect(result.storedEvents).toBe(3);
    expect(result.block).toBe(Number((await getProgress())?.syncedBlockHeight));
    expect(result.block).toBe(200);
    expect(result.events.at(-1)).toMatchObject({
      type: "completed",
      contracts: [{ contractId: CONTRACT_ID, pagesFetched: 3, transactionsFetched: 2 }],
    });
  });

  test("records sync errors", async () => {
    await seedProgress("100:0:0:0", 99);

    const client: StacksClientService = {
      ...makeFakeApi(chainAt([100])).client,
      getContractLogs: () => Effect.die("fetch failed"),
    };

    const sync = createSync({ chainId: CHAIN_ID, client, database: testDb.db });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* sync
          .historical([{ name: "token", contractId: CONTRACT_ID }])
          .pipe(Stream.runDrain, Effect.exit);

        return yield* Metric.value(Metric.withAttributes(syncErrors, { mode: "historical" }));
      }).pipe(
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

    expect(result.count).toBe(1);
  });

  test("keeps per-page detail at debug", async () => {
    await seedProgress("100:0:0:0", 99);

    const sync = createSync({
      chainId: CHAIN_ID,
      client: makeFakeApi(chainAt([100, 200]), 1).client,
      database: testDb.db,
    });

    const logs: CapturedLog[] = [];

    await Effect.runPromise(
      sync
        .historical([{ name: "token", contractId: CONTRACT_ID }])
        .pipe(Stream.runDrain, Effect.provide(Logger.layer([captureLogs(logs)]))),
    );

    expect(logs.every((log) => log.level === "INFO")).toBe(true);
    expect(logs.map((log) => log.message)).not.toContain("Fetched page");
    expect(logs.map((log) => log.message)).toContain(
      "Resuming sync for SP123.token from block 100",
    );
  });

  test("logs per-page fetch and store detail at debug", async () => {
    await seedProgress("100:0:0:0", 99);

    const sync = createSync({
      chainId: CHAIN_ID,
      client: makeFakeApi(chainAt([100, 200]), 1).client,
      database: testDb.db,
    });

    const logs: CapturedLog[] = [];

    await Effect.runPromise(
      sync
        .historical([{ name: "token", contractId: CONTRACT_ID }])
        .pipe(
          Stream.runDrain,
          Effect.provide(Logger.layer([captureLogs(logs)])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        ),
    );

    const fetched = logs.find((log) => log.message === "Fetched page");
    const stored = logs.find((log) => log.message === "Stored page");

    expect(fetched?.level).toBe("DEBUG");
    expect(fetched?.annotations).toMatchObject({
      chainId: CHAIN_ID,
      contractId: CONTRACT_ID,
      phase: "fetch",
      block: 100,
      events: 1,
      durationMs: expect.any(Number),
    });
    expect(stored?.annotations).toMatchObject({
      chainId: CHAIN_ID,
      contractId: CONTRACT_ID,
      phase: "store",
      events: 1,
      transactions: 1,
      durationMs: expect.any(Number),
    });
    expect(logs.some((log) => log.message === "Sync complete for SP123.token")).toBe(true);
  });

  test("warns when fetching a page is slow", async () => {
    await seedProgress("200:0:0:0", 199);

    const fetchStarted = Effect.runSync(Deferred.make<"fetch-started">());

    const sync = createSync({
      chainId: CHAIN_ID,
      client: withSlowForwardPages(makeFakeApi(chainAt([200]), 1), fetchStarted),
      database: testDb.db,
    });

    const logs: CapturedLog[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            sync.historical([{ name: "token", contractId: CONTRACT_ID }]).pipe(Stream.runDrain),
          );

          yield* Deferred.await(fetchStarted);
          yield* TestClock.adjust("11 seconds");

          return yield* Fiber.join(fiber);
        }),
      ).pipe(Effect.provide(TestClock.layer()), Effect.provide(Logger.layer([captureLogs(logs)]))),
    );

    const warning = logs.find(
      (log) => log.message === "Fetching contract logs is taking longer than expected",
    );

    expect(warning?.level).toBe("WARN");
    expect(warning?.annotations).toMatchObject({
      chainId: CHAIN_ID,
      contractId: CONTRACT_ID,
      phase: "fetch",
      block: 200,
      durationMs: 11_000,
    });
  });
});

describe("sync historical block sources", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;
  // oxlint-disable-next-line init-declarations
  let chain: FakeChain;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    // The HTTP client may keep the first `fetch` it sees; delegate to the current test's chain.
    vi.stubGlobal("fetch", (input: string | URL | Request) => chain.fetch(input));
  });

  beforeEach(async () => {
    await testDb.cleanup();
    // Blocks below 100 do not exist: requests for them get a 404.
    chain = createFakeChain({ baseHeight: 100 });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await testDb.close();
  });

  const mineTo = (height: number) => {
    while (chain.blocks[chain.blocks.length - 1].height < height) {
      chain.mine();
    }
  };

  /** Heights from `from` to `to` (inclusive) that are `step` apart; empty when `to < from`. */
  const range = (from: number, to: number, step = 1) =>
    Array.from(
      { length: Math.max(Math.floor((to - from) / step) + 1, 0) },
      (_, index) => from + index * step,
    );

  const runBlockSync = (
    blocks: readonly BlockSyncFilter[],
    tipBlockHeight: number | undefined,
    options: {
      readonly filters?: readonly SyncFilter[];
      /** Called on each `safe` event, before the sync stores anything more. */
      readonly onSafe?: (safeBlockHeight: number) => Promise<void>;
    } = {},
  ) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* StacksClient;
        const events: SyncEvent[] = [];

        yield* createSync({ chainId: CHAIN_ID, client, database: testDb.db })
          .historical(options.filters ?? [], { blocks, tipBlockHeight })
          .pipe(
            Stream.runForEach((event) =>
              Effect.promise(async () => {
                events.push(event);

                if (event.type === "safe") {
                  await options.onSafe?.(event.safeBlockHeight);
                }
              }),
            ),
          );

        return events;
      }).pipe(
        Effect.provide(StacksClient.layer({ baseUrl: "https://api.example.com" })),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

  const storedHeights = async () =>
    (await testDb.db.select().from(blocksTable).orderBy(blocksTable.height)).map((row) =>
      Number(row.height),
    );

  const blockRequests = () =>
    chain.requests.filter((request) => /^\/extended\/v[23]\/(?:bitcoin-)?blocks/u.test(request));

  const getBlockProgress = (name: string) =>
    testDb.run(syncStore.getBlockSyncProgress({ chainId: CHAIN_ID, name }));

  test("stores the source's heights up to endBlock, paging windows of three or more", async () => {
    mineTo(200);

    const events = await runBlockSync(
      [{ name: "Weekly", interval: 7, startBlock: 103, endBlock: 150 }],
      200,
    );

    await expect(storedHeights()).resolves.toStrictEqual(range(103, 150, 7));
    // Window 103..132 holds 103, 110, 117, 124, 131: one Stacks page and one
    // Bitcoin page, down from 131. Window 138..150 holds 138, 145: read one by one.
    expect(blockRequests()).toStrictEqual([
      "/extended/v3/blocks?cursor=131&limit=29",
      "/extended/v3/bitcoin-blocks?cursor=131&limit=29",
      "/extended/v2/blocks/138",
      "/extended/v2/blocks/145",
    ]);
    // A paged block is stored as the single-block endpoint serves it, with its Bitcoin time.
    await expect(
      testDb.db.select().from(blocksTable).where(eq(blocksTable.height, 117n)),
    ).resolves.toStrictEqual([
      {
        chainId: 1n,
        height: 117n,
        hash: "0x117",
        indexBlockHash: "index-0x117",
        blockTime: 1170n,
        tenureHeight: 117n,
      },
    ]);
    await expect(getBlockProgress("Weekly")).resolves.toMatchObject({
      interval: 7n,
      startBlock: 103n,
      syncedBlockHeight: 150n,
      isComplete: true,
    });
    expect(events.map((event) => event.type)).toStrictEqual(["started", "safe", "completed"]);
    expect(events[0]).toMatchObject({
      blocks: [{ name: "Weekly", doneAtStart: false, lastBlockHeight: 102 }],
    });
    expect(events[1]).toMatchObject({ safeBlockHeight: 137 });
    expect(events.at(-1)).toMatchObject({
      blocks: [
        {
          name: "Weekly",
          doneAtStart: false,
          lastBlockHeight: 150,
          initialBlockHeight: 102,
          requests: 4,
          blocksFetched: 7,
        },
      ],
    });
  });

  test("stores the block fields the API serves", async () => {
    mineTo(120);

    await runBlockSync([{ name: "Once", interval: 1, startBlock: 110, endBlock: 110 }], 120);

    await expect(testDb.db.select().from(blocksTable)).resolves.toStrictEqual([
      {
        chainId: 1n,
        height: 110n,
        hash: "0x110",
        indexBlockHash: "index-0x110",
        blockTime: 1100n,
        tenureHeight: 110n,
      },
    ]);
  });

  test("stops at the tip when it is below endBlock", async () => {
    mineTo(200);

    await runBlockSync([{ name: "Every10", interval: 10, startBlock: 100, endBlock: 300 }], 200);

    await expect(storedHeights()).resolves.toStrictEqual(range(100, 200, 10));
    await expect(getBlockProgress("Every10")).resolves.toMatchObject({
      syncedBlockHeight: 200n,
      isComplete: false,
    });
  });

  test("reads windows of fewer than three missing heights block by block", async () => {
    mineTo(200);

    await runBlockSync([{ name: "Every30", interval: 30, startBlock: 105 }], 200);

    expect(blockRequests()).toStrictEqual([
      "/extended/v2/blocks/105",
      "/extended/v2/blocks/135",
      "/extended/v2/blocks/165",
      "/extended/v2/blocks/195",
    ]);
    await expect(storedHeights()).resolves.toStrictEqual([105, 135, 165, 195]);
    // Without an endBlock the source is synced to the tip, never complete.
    await expect(getBlockProgress("Every30")).resolves.toMatchObject({
      syncedBlockHeight: 200n,
      isComplete: false,
    });
  });

  test("skips heights where the chain has no block", async () => {
    mineTo(130);

    // Heights 90..99 are below the fake chain's first block.
    await runBlockSync([{ name: "Early", interval: 40, startBlock: 50 }], 130);

    expect(blockRequests()).toStrictEqual([
      "/extended/v2/blocks/50",
      "/extended/v2/blocks/90",
      "/extended/v2/blocks/130",
    ]);
    await expect(storedHeights()).resolves.toStrictEqual([130]);
    await expect(getBlockProgress("Early")).resolves.toMatchObject({ syncedBlockHeight: 130n });
  });

  test("does not request heights already stored", async () => {
    mineTo(200);

    const storedRow = (height: number) => ({
      chainId: 1n,
      height: BigInt(height),
      hash: `0x${height}`,
      indexBlockHash: `index-0x${height}`,
      blockTime: BigInt(height * 10),
      tenureHeight: BigInt(height),
    });

    await testDb.db.insert(blocksTable).values([110, 120, 140].map(storedRow));

    await runBlockSync(
      [
        { name: "OneMissing", interval: 10, startBlock: 110, endBlock: 130 },
        { name: "AllStored", interval: 30, startBlock: 110, endBlock: 140 },
      ],
      200,
    );

    // 110 and 120 are stored: the window's only missing height is read directly.
    expect(blockRequests()).toStrictEqual(["/extended/v2/blocks/130"]);
    await expect(storedHeights()).resolves.toStrictEqual([110, 120, 130, 140]);
    await expect(getBlockProgress("OneMissing")).resolves.toMatchObject({
      syncedBlockHeight: 130n,
      isComplete: true,
    });
    await expect(getBlockProgress("AllStored")).resolves.toMatchObject({
      syncedBlockHeight: 140n,
      isComplete: true,
    });
  });

  test("stores the right blocks when the head moved after the tip was read", async () => {
    mineTo(160);
    const tip = 160;
    // Ten blocks land between the tip read and the first blocks page.
    mineTo(170);

    await runBlockSync([{ name: "Every5", interval: 5, startBlock: 120 }], tip);

    // Nothing above the tip is stored, nothing at or below it is missed.
    await expect(storedHeights()).resolves.toStrictEqual(range(120, 160, 5));
    expect(blockRequests()).toStrictEqual([
      "/extended/v3/blocks?cursor=145&limit=26",
      "/extended/v3/bitcoin-blocks?cursor=145&limit=26",
      "/extended/v3/blocks?cursor=160&limit=11",
      "/extended/v3/bitcoin-blocks?cursor=160&limit=11",
    ]);
    await expect(getBlockProgress("Every5")).resolves.toMatchObject({ syncedBlockHeight: 160n });
  });

  test("reads heights a blocks page misses one by one", async () => {
    mineTo(110);

    // 90 and 95 are below the fake chain's first block (100).
    await runBlockSync([{ name: "Early", interval: 5, startBlock: 90 }], 110);

    expect(blockRequests()).toStrictEqual([
      "/extended/v3/blocks?cursor=110&limit=21",
      "/extended/v3/bitcoin-blocks?cursor=110&limit=11",
      "/extended/v2/blocks/90",
      "/extended/v2/blocks/95",
    ]);
    await expect(storedHeights()).resolves.toStrictEqual([100, 105, 110]);
    await expect(getBlockProgress("Early")).resolves.toMatchObject({ syncedBlockHeight: 110n });
  });

  test("resumes from saved progress without new block requests", async () => {
    mineTo(200);
    const source = { name: "Every10", interval: 10, startBlock: 100 };

    await runBlockSync([source], 200);
    chain.requests.length = 0;

    const resumed = await runBlockSync([source], 200);

    expect(blockRequests()).toStrictEqual([]);
    expect(resumed.map((event) => event.type)).toStrictEqual(["started", "completed"]);
    expect(resumed[0]).toMatchObject({ blocks: [{ doneAtStart: true, lastBlockHeight: 200 }] });

    mineTo(215);
    chain.requests.length = 0;
    await runBlockSync([source], 215);

    expect(blockRequests()).toStrictEqual(["/extended/v2/blocks/210"]);
    await expect(storedHeights()).resolves.toStrictEqual(range(100, 210, 10));
    await expect(getBlockProgress("Every10")).resolves.toMatchObject({ syncedBlockHeight: 215n });
  });

  test("restarts from startBlock when the interval changes", async () => {
    mineTo(200);

    await runBlockSync([{ name: "Source", interval: 10, startBlock: 100, endBlock: 150 }], 200);
    chain.requests.length = 0;

    const events = await runBlockSync(
      [{ name: "Source", interval: 25, startBlock: 100, endBlock: 150 }],
      200,
    );

    // 100 and 150 are already stored; 125 is new to the changed interval.
    expect(blockRequests()).toStrictEqual(["/extended/v2/blocks/125"]);
    expect(events[0]).toMatchObject({ blocks: [{ doneAtStart: false, lastBlockHeight: 99 }] });
    await expect(getBlockProgress("Source")).resolves.toMatchObject({
      interval: 25n,
      startBlock: 100n,
      syncedBlockHeight: 150n,
      isComplete: true,
    });
  });

  test("restarts from startBlock when startBlock changes", async () => {
    mineTo(200);

    await runBlockSync([{ name: "Source", interval: 30, startBlock: 120, endBlock: 180 }], 200);
    chain.requests.length = 0;

    await runBlockSync([{ name: "Source", interval: 30, startBlock: 105, endBlock: 180 }], 200);

    expect(blockRequests()).toStrictEqual([
      "/extended/v2/blocks/105",
      "/extended/v2/blocks/135",
      "/extended/v2/blocks/165",
    ]);
    await expect(storedHeights()).resolves.toStrictEqual([105, 120, 135, 150, 165, 180]);
    await expect(getBlockProgress("Source")).resolves.toMatchObject({
      interval: 30n,
      startBlock: 105n,
      syncedBlockHeight: 180n,
      isComplete: true,
    });
  });

  test("does not advance a source without a chain tip", async () => {
    mineTo(200);

    const fresh = await runBlockSync([{ name: "Fresh", interval: 10, startBlock: 120 }], undefined);

    expect(blockRequests()).toStrictEqual([]);
    expect(fresh.at(-1)).toMatchObject({ blocks: [{ name: "Fresh", lastBlockHeight: 119 }] });
    await expect(getBlockProgress("Fresh")).resolves.toMatchObject({
      syncedBlockHeight: 119n,
      isComplete: false,
    });

    await testDb.run(
      syncStore.upsertBlockSyncProgress({
        chainId: CHAIN_ID,
        name: "Fresh",
        interval: 10,
        startBlock: 120,
        syncedBlockHeight: 150,
        isComplete: false,
      }),
    );

    const resumed = await runBlockSync(
      [{ name: "Fresh", interval: 10, startBlock: 120 }],
      undefined,
    );

    expect(blockRequests()).toStrictEqual([]);
    expect(resumed.at(-1)).toMatchObject({ blocks: [{ lastBlockHeight: 150 }] });
    await expect(getBlockProgress("Fresh")).resolves.toMatchObject({ syncedBlockHeight: 150n });
  });

  test("emits safe heights at which both contract events and source blocks are stored", async () => {
    // The contract prints at 150, then the chain grows to 200.
    mineTo(149);
    chain.mine([{ txId: "tx-150", events: [{ contractId: CONTRACT_ID, eventIndex: 0 }] }]);
    mineTo(200);

    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: null,
        syncedBlockHeight: 120,
      }),
    );

    const checkedSafeHeights: number[] = [];

    await runBlockSync([{ name: "Every", interval: 1, startBlock: 101, endBlock: 200 }], 200, {
      filters: [{ name: "token", contractId: CONTRACT_ID }],
      onSafe: async (safe) => {
        checkedSafeHeights.push(safe);

        // Every source block up to the safe height is stored.
        expect((await storedHeights()).filter((height) => height <= safe)).toStrictEqual(
          range(101, safe),
        );

        // The contract's event is stored before the safe height passes it.
        const eventHeights = (
          await testDb.run(syncStore.getEvents({ chainId: CHAIN_ID, fromBlockHeight: 0 }))
        ).map((stored) => Number(stored.blockHeight));

        expect(eventHeights.filter((height) => height <= safe)).toStrictEqual(
          [150].filter((height) => height <= safe),
        );
      },
    });

    expect(checkedSafeHeights.length).toBeGreaterThan(0);
    expect(checkedSafeHeights).toStrictEqual(checkedSafeHeights.toSorted((a, b) => a - b));
    await expect(storedHeights()).resolves.toStrictEqual(range(101, 200));
  });
});
