// oxlint-disable typescript/no-unsafe-assignment

import { Deferred, Effect, Fiber, Logger, Metric, References, Stream } from "effect";
import { TestClock } from "effect/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { StacksClientService } from "../datasources/api/index.ts";
import { syncErrors, syncEvents, syncPages } from "../lib/metrics.ts";
import { syncStore } from "../sync-store/index.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { createSync } from "./index.ts";

const CHAIN_ID = 1;

const CONTRACT_ID = "SP123.token";

const transaction = (txId: string, height: number, hash: string) => ({
  tx_id: txId,
  sender: { address: "SP sender", nonce: 0 },
  fee_rate: "1000",
  block: { height, hash, tx_index: 0, time: height * 10 },
  bitcoin_block: { height, time: height * 10 },
  status: "success",
  type: "contract_call",
});

const logPage = (txId: string, nextCursor: string | null) => ({
  results: [
    {
      tx_id: txId,
      event_index: 0,
      event_type: "smart_contract_log",
      contract_log: {
        contract_id: CONTRACT_ID,
        topic: "print",
        value: { hex: "0x01", repr: "(ok true)" },
      },
    },
  ],
  limit: 100,
  offset: 0,
  total: 1,
  next_cursor: nextCursor,
  prev_cursor: null,
});

/**
 * Module-level fixtures and lookups so the test bodies stay free of
 * conditionals.
 */
const pageForCursor = (cursor: string | undefined) => {
  if (cursor === "200:0:0:0") {
    return logPage("tx-2", null);
  }

  return logPage("tx-1", "200:0:0:0");
};

const pageForOptions = (options: { cursor?: string } | undefined) => pageForCursor(options?.cursor);

const transactionForId = (txId: string) => {
  if (txId === "tx-2") {
    return transaction("tx-2", 200, "block-2");
  }

  return transaction("tx-1", 100, "block-1");
};

const notUsed = () => Effect.die("StacksClient method not used in this test");

/** Always returns the same page so an unbounded producer would loop forever. */
const repeatingPage = logPage("tx-1", "200:0:0:0");

const makeSyncClient = (): StacksClientService => ({
  getStatus: notUsed,
  getBlock: notUsed,
  getBlockTransactions: notUsed,
  getTransaction: notUsed,
  getV1Transaction: notUsed,
  getTransactionsBatch: (txIds: string[]) =>
    // SAFETY: The mock returns fixtures shaped like the batch endpoint response; `never` satisfies the expected success type.
    Effect.succeed({ results: txIds.map(transactionForId) } as never),
  getTransactionEvents: notUsed,
  getPrincipalTransactions: notUsed,
  getContract: notUsed,
  getContractLogs: (_contractId: string, options?: { cursor?: string }) =>
    // SAFETY: The mock returns fixtures shaped like the logs endpoint response; `never` satisfies the expected success type.
    Effect.succeed(pageForOptions(options) as never),
  callReadFunction: notUsed,
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

  test("streams started, safe and completed while persisting fetched data", async () => {
    const client = makeSyncClient();

    // Seed progress so initialization resumes from a saved cursor instead of
    // Running first-cursor discovery.
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    const sync = createSync({ chainId: CHAIN_ID, client, database: testDb.db });

    const events = await Effect.runPromise(
      sync
        .historical([{ contractId: CONTRACT_ID }])
        .pipe(Stream.runCollect, Effect.provideService(References.MinimumLogLevel, "None")),
    );

    expect(events.map((event) => event.type)).toStrictEqual(["started", "safe", "completed"]);
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
          initialBlockHeight: 100,
          pagesFetched: 1,
          transactionsFetched: 1,
          eventsStored: 1,
        },
      ],
    });
    expect(events[2]).toMatchObject({
      type: "completed",
      contracts: [{ contractId: CONTRACT_ID, doneAtStart: false, lastBlockHeight: 199 }],
    });

    const storedEvents = await testDb.run(
      syncStore.getEvents({ chainId: CHAIN_ID, fromBlockHeight: 0 }),
    );

    expect(storedEvents).toHaveLength(2);

    const progress = await testDb.run(
      syncStore.getSyncProgress({ contractId: CONTRACT_ID, chainId: CHAIN_ID }),
    );

    expect(progress).toMatchObject({ cursor: null, lastBlockHeight: 200n, isComplete: false });
  });

  test("bounds fetching while the consumer is busy", async () => {
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    let pageCalls = 0;

    const client: StacksClientService = {
      getStatus: notUsed,
      getBlock: notUsed,
      getBlockTransactions: notUsed,
      getTransaction: notUsed,
      getV1Transaction: notUsed,
      getTransactionsBatch: (txIds: string[]) =>
        // SAFETY: The mock returns fixtures shaped like the batch endpoint response; `never` satisfies the expected success type.
        Effect.succeed({ results: txIds.map(transactionForId) } as never),
      getTransactionEvents: notUsed,
      getPrincipalTransactions: notUsed,
      getContract: notUsed,
      getContractLogs: () => {
        pageCalls += 1;

        // SAFETY: The mock returns a fixture shaped like the logs endpoint response; `never` satisfies the expected success type.
        return Effect.succeed(repeatingPage as never);
      },
      callReadFunction: notUsed,
    };

    const sync = createSync({ chainId: CHAIN_ID, client, database: testDb.db });

    // The consumer blocks on the first event, so the producer should only be
    // Able to run ahead by the queue capacity.
    const fiber = Effect.runFork(
      sync.historical([{ contractId: CONTRACT_ID }]).pipe(
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
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    const sync = createSync({ chainId: CHAIN_ID, client: makeSyncClient(), database: testDb.db });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* sync
          .historical([{ contractId: CONTRACT_ID }])
          .pipe(Stream.runCollect);

        const pages = yield* Metric.value(syncPages);
        const storedEvents = yield* Metric.value(syncEvents);

        return { events, pages: pages.count, storedEvents: storedEvents.count };
      }).pipe(
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

    expect(result.pages).toBe(2);
    expect(result.storedEvents).toBe(2);
    expect(result.events[2]).toMatchObject({
      type: "completed",
      contracts: [{ contractId: CONTRACT_ID, pagesFetched: 2, transactionsFetched: 2 }],
    });
  });

  test("records sync errors", async () => {
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    const client: StacksClientService = {
      ...makeSyncClient(),
      getContractLogs: () => Effect.die("fetch failed"),
    };

    const sync = createSync({ chainId: CHAIN_ID, client, database: testDb.db });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        yield* sync.historical([{ contractId: CONTRACT_ID }]).pipe(Stream.runDrain, Effect.exit);

        return yield* Metric.value(syncErrors);
      }).pipe(
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

    expect(result.count).toBe(1);
  });

  test("keeps per-page detail at debug", async () => {
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    const sync = createSync({ chainId: CHAIN_ID, client: makeSyncClient(), database: testDb.db });
    const logs: CapturedLog[] = [];

    await Effect.runPromise(
      sync
        .historical([{ contractId: CONTRACT_ID }])
        .pipe(Stream.runDrain, Effect.provide(Logger.layer([captureLogs(logs)]))),
    );

    expect(logs.every((log) => log.level === "INFO")).toBe(true);
    expect(logs.map((log) => log.message)).not.toContain("Fetched page");
    expect(logs.map((log) => log.message)).toContain(
      "Resuming sync for SP123.token from block 100",
    );
  });

  test("logs per-page fetch and store detail at debug", async () => {
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    const sync = createSync({ chainId: CHAIN_ID, client: makeSyncClient(), database: testDb.db });
    const logs: CapturedLog[] = [];

    await Effect.runPromise(
      sync
        .historical([{ contractId: CONTRACT_ID }])
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
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: "200:0:0:0",
        lastBlockHeight: 200,
        isComplete: false,
      }),
    );

    const fetchStarted = Effect.runSync(Deferred.make<"fetch-started">());

    const client: StacksClientService = {
      ...makeSyncClient(),
      getContractLogs: () =>
        Deferred.succeed(fetchStarted, "fetch-started").pipe(
          Effect.andThen(Effect.sleep("11 seconds")),
          // SAFETY: The mock returns a fixture shaped like the logs endpoint response; `never` satisfies the expected success type.
          Effect.andThen(Effect.succeed(pageForCursor("200:0:0:0") as never)),
        ),
    };

    const sync = createSync({ chainId: CHAIN_ID, client, database: testDb.db });
    const logs: CapturedLog[] = [];

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const fiber = yield* Effect.forkScoped(
            sync.historical([{ contractId: CONTRACT_ID }]).pipe(Stream.runDrain),
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
