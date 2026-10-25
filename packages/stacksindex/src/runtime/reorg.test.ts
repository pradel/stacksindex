import { Effect, Metric } from "effect";
import { HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { StacksClient, type StacksClientService } from "../datasources/api/index.ts";
import { ReorgError } from "../lib/errors.ts";
import { reorgDepth, reorgs } from "../lib/metrics.ts";
import { syncStore } from "../sync-store/index.ts";
import { blocksTable } from "../sync-store/schema.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { reconcileWithCanonicalChain } from "./reorg.ts";

const CHAIN_ID = 1;

const CONTRACT_ID = "SP123.token";

const notFound = (height: number) => {
  const request = HttpClientRequest.get(`https://api.example.com/extended/v2/blocks/${height}`);

  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.StatusCodeError({
      request,
      response: HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
    }),
  });
};

const notUsed = () => Effect.die("StacksClient method not used in this test");

/** Fake API serving `canonical` block hashes by height; other heights are 404. */
const makeClient = (
  canonical: Record<number, string>,
  requested: number[],
): StacksClientService => ({
  getStatus: notUsed,
  getBlocks: notUsed,
  getBlock: (height) => {
    requested.push(Number(height));
    const hash = canonical[Number(height)];

    // SAFETY: Reconciliation reads only `hash` from the block response.
    return hash === undefined
      ? Effect.fail(notFound(Number(height)))
      : Effect.succeed({ hash } as never);
  },
  getBlockTransactions: notUsed,
  getV1Transaction: notUsed,
  getTransactionsBatch: notUsed,
  getTransactionEvents: notUsed,
  getPrincipalTransactions: notUsed,
  getContract: notUsed,
  getContractLogs: notUsed,
  callReadFunction: notUsed,
});

describe("canonical chain reconciliation", () => {
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

  /**
   * Stores blocks 100..500 (hash `old-<height>`), indexed up to 400 with 200
   * finalized, a contract synced to 500 and, optionally, an anchor at 450.
   */
  const seed = async (anchor: { blockHeight: number; blockHash: string } | null) => {
    await testDb.db.insert(blocksTable).values(
      [100, 200, 300, 400, 500].map((height) => ({
        chainId: 1n,
        height: BigInt(height),
        hash: `old-${height}`,
        indexBlockHash: `index-old-${height}`,
        blockTime: BigInt(height * 10),
        tenureHeight: BigInt(height),
      })),
    );
    await testDb.run(
      syncStore.upsertCheckpoint({
        chainId: CHAIN_ID,
        blockHeight: 400,
        blockTime: 4000,
        finalizedBlockHeight: 200,
        finalizedBlockTime: 2000,
      }),
    );
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: CHAIN_ID,
        cursor: null,
        syncedBlockHeight: 500,
      }),
    );
    await testDb.run(syncStore.setSyncAnchor({ chainId: CHAIN_ID, anchor }));
  };

  const reconcile = (canonical: Record<number, string>, requested: number[] = []) =>
    testDb.run(
      reconcileWithCanonicalChain(CHAIN_ID).pipe(
        Effect.provideService(StacksClient, StacksClient.of(makeClient(canonical, requested))),
      ),
    );

  const storedState = async () => ({
    blocks: (
      await testDb.run(
        syncStore.getStoredBlocks({ chainId: CHAIN_ID, fromBlockHeight: 0, toBlockHeight: 1000 }),
      )
    ).map((block) => block.height),
    checkpoint: Number(
      (await testDb.run(syncStore.getCheckpoint({ chainId: CHAIN_ID })))?.blockHeight,
    ),
    synced: Number(
      (await testDb.run(syncStore.getSyncProgress({ contractId: CONTRACT_ID, chainId: CHAIN_ID })))
        ?.syncedBlockHeight,
    ),
  });

  /** Reconciles against `canonical` in a fresh metric registry and reads the reorg metrics. */
  const reconcileMetrics = (canonical: Record<number, string>) =>
    testDb.run(
      Effect.gen(function* () {
        yield* reconcileWithCanonicalChain(CHAIN_ID);

        return { reorgs: yield* Metric.value(reorgs), depth: yield* Metric.value(reorgDepth) };
      }).pipe(
        Effect.provideService(StacksClient, StacksClient.of(makeClient(canonical, []))),
        Effect.provideService(Metric.MetricRegistry, new Map()),
      ),
    );

  test("keeps indexed data when the anchor is still canonical", async () => {
    await seed({ blockHeight: 450, blockHash: "tip-450" });
    const requested: number[] = [];

    await reconcile({ 450: "tip-450" }, requested);

    // One request; only the never-indexed data above the anchor is dropped.
    expect(requested).toStrictEqual([450]);
    await expect(storedState()).resolves.toStrictEqual({
      blocks: [100, 200, 300, 400],
      checkpoint: 400,
      synced: 450,
    });
  });

  test("rewinds to the highest stored block that is still canonical", async () => {
    await seed({ blockHeight: 450, blockHash: "tip-450" });
    const requested: number[] = [];

    // A reorg replaced everything above 300.
    await reconcile({ 200: "old-200", 300: "old-300", 400: "new-400", 450: "new-450" }, requested);

    expect(requested[0]).toBe(450);
    await expect(storedState()).resolves.toStrictEqual({
      blocks: [100, 200, 300],
      checkpoint: 300,
      synced: 300,
    });
  });

  test("treats a missing anchor block as a reorg", async () => {
    await seed({ blockHeight: 450, blockHash: "tip-450" });

    await reconcile({ 200: "old-200", 300: "old-300", 400: "old-400" });

    await expect(storedState()).resolves.toStrictEqual({
      blocks: [100, 200, 300, 400],
      checkpoint: 400,
      synced: 400,
    });
  });

  test("fails without changing data when the finalized block was replaced", async () => {
    await seed({ blockHeight: 450, blockHash: "tip-450" });

    const error = await testDb.run(
      reconcileWithCanonicalChain(CHAIN_ID).pipe(
        Effect.provideService(
          StacksClient,
          StacksClient.of(makeClient({ 200: "new-200", 300: "new-300", 450: "new-450" }, [])),
        ),
        Effect.flip,
      ),
    );

    expect(error).toBeInstanceOf(ReorgError);
    expect(error).toMatchObject({ finalizedBlockHeight: 200 });
    await expect(storedState()).resolves.toStrictEqual({
      blocks: [100, 200, 300, 400, 500],
      checkpoint: 400,
      synced: 500,
    });
  });

  test("replays everything above the finalized block without an anchor", async () => {
    await seed(null);
    const requested: number[] = [];

    await reconcile({}, requested);

    expect(requested).toStrictEqual([]);
    await expect(storedState()).resolves.toStrictEqual({
      blocks: [100, 200],
      checkpoint: 200,
      synced: 200,
    });
  });

  test("records a reorg and its depth when stored blocks were replaced", async () => {
    await seed({ blockHeight: 450, blockHash: "tip-450" });

    const metrics = await reconcileMetrics({
      200: "old-200",
      300: "old-300",
      400: "new-400",
      450: "new-450",
    });

    // Anchor 450 minus the highest still-canonical stored block, 300.
    expect(metrics.reorgs.count).toBe(1);
    expect(metrics.depth.count).toBe(1);
    expect(metrics.depth.sum).toBe(150);
  });

  test("records no reorg when the anchor is still canonical", async () => {
    await seed({ blockHeight: 450, blockHash: "tip-450" });

    const metrics = await reconcileMetrics({ 450: "tip-450" });

    expect(metrics.reorgs.count).toBe(0);
    expect(metrics.depth.count).toBe(0);
  });
});
