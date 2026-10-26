import { Cause, Effect, Exit, References } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { IndexerDatabase } from "../database/index.ts";
import { ConfigurationError } from "../lib/errors.ts";
import type { PrintEvent } from "../lib/types.ts";
import { syncStore } from "../sync-store/index.ts";
import { checkpointsTable, metaTable } from "../sync-store/schema.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import type { ContractSpec } from "./contracts.ts";
import { Indexer } from "./index.ts";

const TOKEN_ID = "SP123.token";

const POOL_ID = "SP123.pool";

const BASE_HEIGHT = 100;

type TestContract = Pick<ContractSpec, "name" | "contractId" | "startBlock" | "endBlock"> & {
  readonly handled?: number[];
};

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const run = (testDb: TestDatabase, contracts: readonly TestContract[]) =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const indexer = yield* Indexer;

      return yield* indexer.run;
    }).pipe(
      Effect.provide(
        Indexer.layer({
          contracts: contracts.map(({ handled, ...contract }) => ({
            onInvalid: "fail",
            ...contract,
            handler: (event: PrintEvent<unknown>) =>
              Effect.sync(() => {
                handled?.push(event.block.height);
              }),
          })),
        }),
      ),
      Effect.provideService(IndexerDatabase, testDb.db),
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  );

/** Marks the contract synced below `BASE_HEIGHT`, so `run` catches it up without discovery. */
const seedSynced = (testDb: TestDatabase, contractId: string) =>
  testDb.run(
    syncStore.upsertSyncProgress({
      contractId,
      chainId: 1,
      cursor: null,
      syncedBlockHeight: BASE_HEIGHT - 1,
    }),
  );

const checkpointHeight = async (testDb: TestDatabase) => {
  const [checkpoint] = await testDb.db.select().from(checkpointsTable);

  return checkpoint === undefined ? undefined : Number(checkpoint.blockHeight);
};

describe("contract definition changes", () => {
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
    await seedSynced(testDb, TOKEN_ID);
    await seedSynced(testDb, POOL_ID);

    chain = createFakeChain({ baseHeight: BASE_HEIGHT - 1 });
    // Block 100: one print from each contract. Block 101: one token print.
    chain.mine([
      { txId: "tx-100-token", events: [{ contractId: TOKEN_ID, eventIndex: 0 }] },
      { txId: "tx-100-pool", events: [{ contractId: POOL_ID, eventIndex: 0 }] },
    ]);
    chain.mine([{ txId: "tx-101-token", events: [{ contractId: TOKEN_ID, eventIndex: 0 }] }]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await testDb.close();
  });

  test("fails a run that adds a contract with events at or below the checkpoint", async () => {
    expect(Exit.isSuccess(await run(testDb, [{ name: "token", contractId: TOKEN_ID }]))).toBe(true);
    await expect(checkpointHeight(testDb)).resolves.toBe(101);

    const handled: number[] = [];
    const requestsBefore = chain.requests.length;

    const exit = await run(testDb, [
      { name: "token", contractId: TOKEN_ID },
      { name: "pool", contractId: POOL_ID, handled },
    ]);

    const error = failureOf(exit);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(`contracts.pool (${POOL_ID}) was added after blocks up to 101`),
    );
    expect(handled).toStrictEqual([]);
    // Rejected before any request or write.
    expect(chain.requests).toHaveLength(requestsBefore);
    await expect(checkpointHeight(testDb)).resolves.toBe(101);
  });

  test("indexes a contract added with its startBlock above the checkpoint", async () => {
    expect(Exit.isSuccess(await run(testDb, [{ name: "token", contractId: TOKEN_ID }]))).toBe(true);

    chain.mine([{ txId: "tx-102-pool", events: [{ contractId: POOL_ID, eventIndex: 0 }] }]);

    const handled: number[] = [];

    const exit = await run(testDb, [
      { name: "token", contractId: TOKEN_ID },
      { name: "pool", contractId: POOL_ID, startBlock: 102, handled },
    ]);

    expect(Exit.isSuccess(exit)).toBe(true);
    expect(handled).toStrictEqual([102]);
  });

  test("accepts a removed or renamed contract", async () => {
    const both = [
      { name: "token", contractId: TOKEN_ID },
      { name: "pool", contractId: POOL_ID },
    ];

    expect(Exit.isSuccess(await run(testDb, both))).toBe(true);
    expect(Exit.isSuccess(await run(testDb, [{ name: "coin", contractId: TOKEN_ID }]))).toBe(true);
  });

  test("fails a run that changes the block range of an indexed contract", async () => {
    expect(Exit.isSuccess(await run(testDb, [{ name: "token", contractId: TOKEN_ID }]))).toBe(true);

    const exit = await run(testDb, [{ name: "token", contractId: TOKEN_ID, startBlock: 101 }]);

    const error = failureOf(exit);
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toHaveProperty(
      "message",
      expect.stringContaining(
        `contracts.token (${TOKEN_ID}) changed from startBlock unset, endBlock unset to startBlock 101, endBlock unset after indexing reached block 101`,
      ),
    );
  });

  test('keeps accepting endBlock "latest" as the chain tip moves', async () => {
    const contracts = [{ name: "token", contractId: TOKEN_ID, endBlock: "latest" as const }];

    expect(Exit.isSuccess(await run(testDb, contracts))).toBe(true);

    chain.mine([{ txId: "tx-102-token", events: [{ contractId: TOKEN_ID, eventIndex: 0 }] }]);

    expect(Exit.isSuccess(await run(testDb, contracts))).toBe(true);
    await expect(checkpointHeight(testDb)).resolves.toBe(102);
  });

  test("checks later changes against the contracts of a database indexed before they were recorded", async () => {
    expect(Exit.isSuccess(await run(testDb, [{ name: "token", contractId: TOKEN_ID }]))).toBe(true);
    // As left by a version that did not record contracts.
    await testDb.db.delete(metaTable);

    expect(Exit.isSuccess(await run(testDb, [{ name: "token", contractId: TOKEN_ID }]))).toBe(true);

    const exit = await run(testDb, [
      { name: "token", contractId: TOKEN_ID },
      { name: "pool", contractId: POOL_ID },
    ]);

    expect(failureOf(exit)).toBeInstanceOf(ConfigurationError);
  });
});
