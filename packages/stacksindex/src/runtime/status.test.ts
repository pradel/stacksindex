import { Effect, Fiber, Metric, References, Schedule } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { IndexerDatabase } from "../database/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import { syncStore } from "../sync-store/index.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { Indexer, type IndexerService } from "./index.ts";

const CONTRACT_ID = "SP123.token";

const BASE_HEIGHT = 100;

/** Runs `program` against one `Indexer` layer, so `status` sees the phase its `run` left. */
const withIndexer = <A, E>(
  testDb: TestDatabase,
  program: (indexer: IndexerService) => Effect.Effect<A, E>,
): Promise<A> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* program(yield* Indexer);
    }).pipe(
      Effect.provide(Indexer.layer({ finality: 0, live: { pollingInterval: 100 } })),
      Effect.provideService(IndexerDatabase, testDb.db),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  );

describe("indexer status", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;
  // oxlint-disable-next-line init-declarations
  let chain: FakeChain;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    // The HTTP client may keep the first `fetch` it sees; delegate to the
    // Current test's chain instead of stubbing each chain's own function.
    vi.stubGlobal("fetch", (input: string | URL | Request) => chain.fetch(input));
  });

  beforeEach(async () => {
    await testDb.cleanup();
    // Synced through the block below the tip, so `run` only catches up block 100.
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId: CONTRACT_ID,
        chainId: 1,
        cursor: null,
        syncedBlockHeight: BASE_HEIGHT - 1,
      }),
    );

    chain = createFakeChain({ baseHeight: BASE_HEIGHT - 1 });
    chain.mine([{ txId: "tx-100", events: [{ contractId: CONTRACT_ID, eventIndex: 0 }] }]);
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await testDb.close();
  });

  test("is idle and not ready before any run", async () => {
    const status = await withIndexer(testDb, (indexer) => indexer.status);

    expect(status).toStrictEqual({
      chainId: 1,
      phase: "idle",
      ready: false,
      checkpoint: null,
      anchor: null,
      contracts: [
        { contractId: CONTRACT_ID, syncedBlockHeight: BASE_HEIGHT - 1, isComplete: false },
      ],
    });
  });

  test("is done and ready with the stored progress after a run", async () => {
    const status = await withIndexer(testDb, (indexer) =>
      indexer
        .run([{ contractId: CONTRACT_ID, handler: () => Effect.void }])
        .pipe(Effect.andThen(indexer.status)),
    );

    const checkpoint = await testDb.run(syncStore.getCheckpoint({ chainId: 1 }));

    expect(checkpoint).not.toBeNull();
    expect(status).toStrictEqual({
      chainId: 1,
      phase: "done",
      ready: true,
      checkpoint: {
        blockHeight: BASE_HEIGHT,
        blockTime: Number(checkpoint?.blockTime),
        finalizedBlockHeight: Number(checkpoint?.finalizedBlockHeight),
      },
      anchor: { blockHeight: BASE_HEIGHT },
      contracts: [{ contractId: CONTRACT_ID, syncedBlockHeight: BASE_HEIGHT, isComplete: false }],
    });
  });

  test("is failed and not ready after a failing run", async () => {
    const [error, status] = await withIndexer(testDb, (indexer) =>
      Effect.all([
        Effect.flip(
          indexer.run([{ contractId: CONTRACT_ID, handler: () => Effect.fail(new Error("boom")) }]),
        ),
        indexer.status,
      ]),
    );

    expect(error).toBeInstanceOf(HandlerExecutionError);
    expect(status).toMatchObject({ phase: "failed", ready: false });
  });

  test("a run overlapping live does not end the shared phase", async () => {
    const filters = [
      { contractId: CONTRACT_ID, endBlock: BASE_HEIGHT + 1, handler: () => Effect.void },
    ];

    const phases = await withIndexer(testDb, (indexer) =>
      Effect.gen(function* () {
        const live = yield* Effect.forkChild(indexer.live(filters));

        yield* indexer.status.pipe(
          Effect.repeat({
            until: (status) => status.phase === "live",
            schedule: Schedule.spaced("10 millis"),
          }),
        );
        yield* indexer.run(filters);

        const afterRun = (yield* indexer.status).phase;

        chain.mine();
        yield* Fiber.join(live);

        return [afterRun, (yield* indexer.status).phase];
      }),
    );

    expect(phases).toStrictEqual(["live", "done"]);
  });
});
