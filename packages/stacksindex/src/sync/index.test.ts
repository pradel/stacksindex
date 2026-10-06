// oxlint-disable typescript/no-unsafe-assignment

import { Effect, Fiber, References, Stream } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { StacksClientService } from "../datasources/api/index.ts";
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
      getContractLogs: (_contractId: string, options?: { cursor?: string }) =>
        // SAFETY: The mock returns fixtures shaped like the logs endpoint response; `never` satisfies the expected success type.
        Effect.succeed(pageForOptions(options) as never),
      callReadFunction: notUsed,
    };

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
    expect(events[1]).toMatchObject({ type: "safe", safeBlockHeight: 99 });
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
});
