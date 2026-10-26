import { Cause, Effect, Exit, Fiber, Metric, References } from "effect";
import type { Socket } from "effect/socket";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vite-plus/test";

import { IndexerDatabase } from "../database/index.ts";
import { EventDecodeError, HandlerExecutionError, ReorgError } from "../lib/errors.ts";
import { liveConsecutiveFailures, liveIsRealtime, syncErrors } from "../lib/metrics.ts";
import type { BlockEvent, PrintEvent } from "../lib/types.ts";
import { defineIndexer } from "../promise/index.ts";
import { syncStore } from "../sync-store/index.ts";
import { checkpointsTable, eventsTable, syncProgressTable } from "../sync-store/schema.ts";
import { createFakeChain, type FakeChain, type FakeTransaction } from "../test-utils/fake-chain.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { freshDatabase } from "../test/fresh-database.ts";
import type { BlockSourceSpec } from "./blocks.ts";
import type { ContractSpec } from "./contracts.ts";
import { Indexer, type IndexerOptions } from "./index.ts";

const CONTRACT_ID = "SP123.token";

const BASE_HEIGHT = 100;

const logTx = (txId: string, contractId = CONTRACT_ID): FakeTransaction => ({
  txId,
  events: [{ contractId, eventIndex: 0 }],
});

interface HandledEvent {
  readonly height: number;
  readonly txId: string;
}

type TestContract = Pick<ContractSpec, "contractId" | "startBlock" | "endBlock" | "handler"> &
  Partial<Pick<ContractSpec, "decode">>;

const recordingHandler = (handled: HandledEvent[]) => (event: PrintEvent<unknown>) =>
  Effect.sync(() => {
    handled.push({ height: event.block.height, txId: event.txId });
  });

const seedSynced = (testDb: TestDatabase, contractId: string) =>
  testDb.run(
    syncStore.upsertSyncProgress({
      contractId,
      chainId: 1,
      cursor: null,
      syncedBlockHeight: BASE_HEIGHT - 1,
    }),
  );

/**
 * `live` runs started by the current test. A test that times out leaves its
 * run polling against the shared database, so `afterEach` interrupts them
 * before the next test resets it (or `afterAll` closes it).
 */
const liveFibers = new Set<Fiber.Fiber<void, unknown>>();

/**
 * Runs `live` on the Effect API with fast polling. Contracts are seeded as
 * synced through `BASE_HEIGHT - 1`, so no first-event discovery is needed.
 * `options.blocks` adds block sources.
 */
const runLive = (
  testDb: TestDatabase,
  contracts: TestContract[],
  options: IndexerOptions & { readonly blocks?: readonly BlockSourceSpec[] } = {},
  registry: Metric.MetricRegistry = new Map(),
): Promise<Exit.Exit<void, unknown>> => {
  const fiber = Effect.runFork(
    Effect.gen(function* () {
      const indexer = yield* Indexer;

      yield* indexer.live;
    }).pipe(
      Effect.provide(
        Indexer.layer({
          live: { pollingInterval: 100 },
          ...options,
          contracts: contracts.map((contract) => ({
            name: contract.contractId,
            onInvalid: "fail",
            ...contract,
          })),
        }),
      ),
      Effect.provideService(IndexerDatabase, testDb.db),
      Effect.provideService(Metric.MetricRegistry, registry),
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  );

  liveFibers.add(fiber);

  return Effect.runPromise(Fiber.await(fiber)).finally(() => {
    liveFibers.delete(fiber);
  });
};

/**
 * Current value of the series of `metric` carrying `attributes`, ignoring any
 * other attribute (such as the chain id the indexer adds). Synchronous, so
 * handlers can sample it mid-pass.
 */
const readMetric = (
  registry: Metric.MetricRegistry,
  metric: Metric.Metric<number, unknown>,
  attributes: Record<string, string> = {},
): number | undefined => {
  const series = Effect.runSync(
    Metric.snapshot.pipe(Effect.provideService(Metric.MetricRegistry, registry)),
  ).find(
    (snapshot) =>
      snapshot.id === metric.id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

  if (series?.type === "Counter") {
    return Number(series.state.count);
  }

  return series?.type === "Gauge" ? Number(series.state.value) : undefined;
};

const failureOf = (exit: Exit.Exit<void, unknown>) =>
  Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;

const failOnBlock = (height: number) => (event: PrintEvent<unknown>) =>
  event.block.height === height ? Effect.fail(new Error("boom")) : Effect.void;

/** A `print` decoder that accepts every value until `schemaChanged()` turns true. */
const decodeUntil =
  (schemaChanged: () => boolean): NonNullable<ContractSpec["decode"]> =>
  (value) =>
    schemaChanged() ? Effect.fail({ message: "Expected a swap" }) : Effect.succeed(value);

/** Runs one scripted step per head poll, after the first poll. */
const scriptHeads = (chain: FakeChain, steps: readonly (() => void)[]) => {
  const pending = [...steps];
  let polls = 0;

  chain.onHeadPoll = () => {
    polls += 1;

    if (polls > 1) {
      pending.shift()?.();
    }
  };
};

const getBlockRequests = (chain: FakeChain) =>
  chain.requests.filter((request) => /^\/extended\/v2\/blocks\/[^/?]+$/u.test(request));

const countRequests = (chain: FakeChain, pattern: RegExp) =>
  chain.requests.filter((request) => pattern.test(request)).length;

/** Records prints as `print <height> <txId>`, in handling order. */
const logPrints = (log: string[]) => (event: PrintEvent<unknown>) =>
  Effect.sync(() => {
    log.push(`print ${event.block.height} ${event.txId}`);
  });

/** A block source recording its runs as `<name> <height> <hash>` into `log`. */
const loggedBlockSource = (
  log: string[],
  source: Pick<BlockSourceSpec, "interval" | "startBlock" | "endBlock"> & {
    readonly name?: string;
  },
): BlockSourceSpec => ({
  name: "every",
  ...source,
  handler: (event) =>
    Effect.sync(() => {
      log.push(`${event.name} ${event.block.height} ${event.block.hash}`);
    }),
});

const unwatchedTx = (txId: string): FakeTransaction => ({
  txId,
  events: [{ contractId: "SP9.unwatched", eventIndex: 0 }],
});

type WebSocketListener = (event: Socket.WebSocketEvent) => void;

/**
 * Websocket handed out by the global constructor: open at once, it records
 * the frames the indexer sends and delivers the frames a test passes to
 * `receive`.
 */
class FakeWebSocket implements Socket.WebSocketLike {
  static readonly instances: FakeWebSocket[] = [];
  readyState = 1;
  readonly url: string;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<WebSocketListener>>();

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: WebSocketListener): void {
    const listeners = this.listeners.get(type) ?? new Set();

    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: WebSocketListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    this.sent.push(String(data));
  }

  close(code = 1000): void {
    if (this.readyState < 2) {
      this.readyState = 3;
      this.dispatch("close", { code });
    }
  }

  receive(data: string): void {
    this.dispatch("message", { data });
  }

  private dispatch(type: string, event: Socket.WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

describe("live indexing", () => {
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
    await seedSynced(testDb, CONTRACT_ID);

    chain = createFakeChain({ baseHeight: BASE_HEIGHT - 1 });
    chain.mine([logTx("tx-100")]);
  });

  afterEach(async () => {
    await Effect.runPromise(Fiber.interruptAll(liveFibers));
    liveFibers.clear();
  });

  afterAll(async () => {
    await testDb.close();
  });

  test("indexes blocks as they arrive and stops at the end block", async () => {
    const handled: HandledEvent[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine();
      },
      () => {
        chain.mine([logTx("tx-103")]);
      },
    ]);

    const exit = await runLive(testDb, [
      { contractId: CONTRACT_ID, handler: recordingHandler(handled), endBlock: 103 },
    ]);

    expect(exit).toStrictEqual(Exit.void);
    expect(handled).toStrictEqual([
      { height: 100, txId: "tx-100" },
      { height: 101, txId: "tx-101" },
      { height: 103, txId: "tx-103" },
    ]);

    // Every head built on the previous one, so no canonical-hash lookups.
    expect(getBlockRequests(chain)).toStrictEqual([]);

    const [checkpoint] = await testDb.db.select().from(checkpointsTable);

    expect(Number(checkpoint.blockHeight)).toBe(103);
    // Default finality keeps the 6 newest blocks unfinalized.
    expect(Number(checkpoint.finalizedBlockHeight)).toBeLessThanOrEqual(97);

    await expect(testDb.run(syncStore.getSyncAnchor({ chainId: 1 }))).resolves.toStrictEqual({
      blockHeight: 103,
      blockHash: "0x103",
    });
  });

  test("replays the canonical fork after a reorg", async () => {
    const handled: HandledEvent[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101-orphaned")]);
      },
      () => {
        chain.orphanFrom(101);
        chain.mine([logTx("tx-101-canonical")]);
        chain.mine([logTx("tx-102")]);
      },
    ]);

    const exit = await runLive(testDb, [
      { contractId: CONTRACT_ID, handler: recordingHandler(handled), endBlock: 102 },
    ]);

    expect(exit).toStrictEqual(Exit.void);
    expect(handled).toStrictEqual([
      { height: 100, txId: "tx-100" },
      { height: 101, txId: "tx-101-orphaned" },
      { height: 101, txId: "tx-101-canonical" },
      { height: 102, txId: "tx-102" },
    ]);

    // The head's parent was not the anchor, so its canonical hash was checked.
    expect(getBlockRequests(chain)).toContain("/extended/v2/blocks/101");

    const stored = await testDb.db.select({ txId: eventsTable.txId }).from(eventsTable);

    expect(stored.map((row) => row.txId).toSorted()).toStrictEqual([
      "tx-100",
      "tx-101-canonical",
      "tx-102",
    ]);
  });

  test("fails with ReorgError when a reorg replaces a finalized block", async () => {
    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.orphanFrom(101);
        chain.mine([logTx("tx-101-fork")]);
        chain.mine();
      },
    ]);

    const exit = await runLive(testDb, [{ contractId: CONTRACT_ID, handler: () => Effect.void }], {
      finality: 0,
    });

    expect(failureOf(exit)).toBeInstanceOf(ReorgError);
  });

  test("retries a head whose sync failed with the next head", async () => {
    const handled: HandledEvent[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
        // The catch-up request for this head fails once.
        chain.failures.set(`/extended/v2/smart-contracts/${CONTRACT_ID}/logs`, 1);
      },
      () => {
        chain.mine([logTx("tx-102")]);
      },
    ]);

    const exit = await runLive(testDb, [
      { contractId: CONTRACT_ID, handler: recordingHandler(handled), endBlock: 102 },
    ]);

    expect(exit).toStrictEqual(Exit.void);
    expect(handled.map((event) => event.txId)).toStrictEqual(["tx-100", "tx-101", "tx-102"]);
    expect(chain.failures.get(`/extended/v2/smart-contracts/${CONTRACT_ID}/logs`)).toBe(0);
  });

  test("reports realtime only while following new blocks", async () => {
    const registry: Metric.MetricRegistry = new Map();
    const realtimeByTx: Record<string, number | undefined> = {};

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
    ]);

    const exit = await runLive(
      testDb,
      [
        {
          contractId: CONTRACT_ID,
          handler: (event) =>
            Effect.sync(() => {
              realtimeByTx[event.txId] = readMetric(registry, liveIsRealtime);
            }),
          endBlock: 101,
        },
      ],
      {},
      registry,
    );

    expect(exit).toStrictEqual(Exit.void);
    // Block 100 is indexed by the historical pass, block 101 by a live pass.
    expect(realtimeByTx).toStrictEqual({ "tx-100": undefined, "tx-101": 1 });
    expect(readMetric(registry, liveIsRealtime)).toBe(0);
  });

  test("reports failed live passes until one succeeds", async () => {
    const registry: Metric.MetricRegistry = new Map();
    const failuresByTx: Record<string, number | undefined> = {};

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
        chain.failures.set(`/extended/v2/smart-contracts/${CONTRACT_ID}/logs`, 1);
      },
      () => {
        chain.mine([logTx("tx-102")]);
      },
    ]);

    const exit = await runLive(
      testDb,
      [
        {
          contractId: CONTRACT_ID,
          // Handlers run inside the retrying pass, before it succeeds.
          handler: (event) =>
            Effect.sync(() => {
              failuresByTx[event.txId] = readMetric(registry, liveConsecutiveFailures);
            }),
          endBlock: 102,
        },
      ],
      {},
      registry,
    );

    expect(exit).toStrictEqual(Exit.void);
    expect(failuresByTx).toStrictEqual({ "tx-100": undefined, "tx-101": 1, "tx-102": 1 });
    expect(readMetric(registry, liveConsecutiveFailures)).toBe(0);
    expect(readMetric(registry, syncErrors, { mode: "live" })).toBe(1);
  });

  test("fails at once when a handler fails", async () => {
    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine();
      },
    ]);

    const exit = await runLive(testDb, [
      {
        contractId: CONTRACT_ID,
        handler: failOnBlock(101),
      },
    ]);

    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(HandlerExecutionError);
    expect(failure).toMatchObject({ contractId: CONTRACT_ID });
  });

  test("fails at once when a print does not match its schema", async () => {
    // The historical pass decodes block 100; only prints from block 101 on mismatch.
    let mismatch = false;
    const handled: HandledEvent[] = [];

    scriptHeads(chain, [
      () => {
        mismatch = true;
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine();
      },
    ]);

    const exit = await runLive(testDb, [
      {
        contractId: CONTRACT_ID,
        handler: recordingHandler(handled),
        decode: decodeUntil(() => mismatch),
      },
    ]);

    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(EventDecodeError);
    expect(failure).toMatchObject({ contractId: CONTRACT_ID, txId: "tx-101" });
    expect(handled).toStrictEqual([{ height: 100, txId: "tx-100" }]);
  });

  test("ignores a head below the indexed tip instead of replaying", async () => {
    const handled: HandledEvent[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine([logTx("tx-102")]);
        // A lagging replica answers the next poll with block 101.
        chain.staleHeads.push(101);
      },
      () => {
        chain.mine([logTx("tx-103")]);
      },
    ]);

    const exit = await runLive(testDb, [
      { contractId: CONTRACT_ID, handler: recordingHandler(handled), endBlock: 103 },
    ]);

    expect(exit).toStrictEqual(Exit.void);
    expect(chain.staleHeads).toStrictEqual([]);
    expect(handled.map((event) => event.txId)).toStrictEqual([
      "tx-100",
      "tx-101",
      "tx-102",
      "tx-103",
    ]);
  });

  test("catches up a contract whose first-event discovery found nothing", async () => {
    const contractId = "SP1.nested";
    const handled: HandledEvent[] = [];

    chain.mine([logTx("tx-nested-101", contractId)]);

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-nested-102", contractId)]);
      },
    ]);

    // Discovery sees no transaction for the contract, so the historical pass
    // Ends without reading its logs; the first head must still catch it up.
    const exit = await runLive(testDb, [
      { contractId, startBlock: BASE_HEIGHT, handler: recordingHandler(handled), endBlock: 102 },
    ]);

    expect(exit).toStrictEqual(Exit.void);
    expect(handled).toStrictEqual([
      { height: 101, txId: "tx-nested-101" },
      { height: 102, txId: "tx-nested-102" },
    ]);
  });

  test("fetches block by block when that costs fewer requests than one logs page per contract", async () => {
    const contractIds = [CONTRACT_ID, "SP1.b", "SP1.c", "SP1.d", "SP1.e"];

    for (const contractId of contractIds.slice(1)) {
      await seedSynced(testDb, contractId);
    }

    const handled: HandledEvent[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([
          {
            txId: "tx-101",
            events: [
              { contractId: CONTRACT_ID, eventIndex: 0 },
              { contractId: "SP1.c", eventIndex: 1 },
              { contractId: "SP9.unwatched", eventIndex: 2 },
            ],
          },
        ]);
      },
      () => {
        chain.mine();
      },
      () => {
        // The log sits on the second events page.
        chain.mine([
          { txId: "tx-103", assetEvents: 120, events: [{ contractId: "SP1.e", eventIndex: 120 }] },
        ]);
      },
    ]);

    const exit = await runLive(
      testDb,
      contractIds.map((contractId) => ({
        contractId,
        handler: recordingHandler(handled),
        endBlock: 103,
      })),
    );

    expect(exit).toStrictEqual(Exit.void);
    expect(handled).toStrictEqual([
      { height: 100, txId: "tx-100" },
      { height: 101, txId: "tx-101" },
      { height: 101, txId: "tx-101" },
      { height: 103, txId: "tx-103" },
    ]);

    // Only the historical pass read contract logs: one page per contract.
    expect(countRequests(chain, /\/logs\?/u)).toBe(contractIds.length);
    expect(countRequests(chain, /^\/extended\/v3\/blocks\/0x10[1-3]\/transactions/u)).toBe(3);
    expect(countRequests(chain, /^\/extended\/v3\/transactions\/tx-103\/events/u)).toBe(2);
  });

  test("close() ends live indexing on the promise API", async () => {
    const handled: string[] = [];
    let resolveFirstEvent: () => void = () => undefined;

    const firstEvent = new Promise<void>((resolve) => {
      resolveFirstEvent = resolve;
    });

    const indexer = await defineIndexer({ contracts: { token: { id: CONTRACT_ID } } }).create({
      database: await freshDatabase(),
      live: { pollingInterval: 100 },
      logLevel: "None",
      handlers: {
        token: (event) => {
          handled.push(event.txId);
          resolveFirstEvent();
        },
      },
    });

    await indexer.db.insert(syncProgressTable).values({
      chainId: 1n,
      contractId: CONTRACT_ID,
      cursor: null,
      syncedBlockHeight: BigInt(BASE_HEIGHT - 1),
    });

    const live = indexer.live();

    await firstEvent;
    await indexer.close();

    await expect(live).resolves.toBeUndefined();
    expect(handled).toStrictEqual(["tx-100"]);
  });

  test("indexes block sources with each head when fetching per contract", async () => {
    const log: string[] = [];

    // Each head costs one logs page plus, at a source height, one block request;
    // Two transactions make the per-block path dearer.
    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine([unwatchedTx("tx-102-a"), unwatchedTx("tx-102-b")]);
      },
      () => {
        chain.mine();
      },
      () => {
        chain.mine([logTx("tx-104"), unwatchedTx("tx-104-b")]);
      },
    ]);

    const exit = await runLive(
      testDb,
      [{ contractId: CONTRACT_ID, handler: logPrints(log), endBlock: 104 }],
      { blocks: [loggedBlockSource(log, { interval: 2, startBlock: 100, endBlock: 104 })] },
    );

    expect(exit).toStrictEqual(Exit.void);
    // Within a block, prints run before block sources.
    expect(log).toStrictEqual([
      "print 100 tx-100",
      "every 100 0x100",
      "print 101 tx-101",
      "every 102 0x102",
      "print 104 tx-104",
      "every 104 0x104",
    ]);
    expect(countRequests(chain, /^\/extended\/v3\/blocks\//u)).toBe(0);
    // No print stored block 102: the block source fetched it by height.
    expect(getBlockRequests(chain)).toContain("/extended/v2/blocks/102");
  });

  test("indexes block sources with each head when fetching block by block", async () => {
    const contractIds = [CONTRACT_ID, "SP1.b", "SP1.c", "SP1.d", "SP1.e"];

    for (const contractId of contractIds.slice(1)) {
      await seedSynced(testDb, contractId);
    }

    const log: string[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine();
      },
      () => {
        chain.mine();
      },
    ]);

    const exit = await runLive(
      testDb,
      contractIds.map((contractId) => ({ contractId, handler: logPrints(log), endBlock: 103 })),
      { blocks: [loggedBlockSource(log, { interval: 2, startBlock: 100, endBlock: 103 })] },
    );

    expect(exit).toStrictEqual(Exit.void);
    expect(log).toStrictEqual([
      "print 100 tx-100",
      "every 100 0x100",
      "print 101 tx-101",
      "every 102 0x102",
    ]);
    // Only the historical pass read contract logs.
    expect(countRequests(chain, /\/logs\?/u)).toBe(contractIds.length);
    expect(countRequests(chain, /^\/extended\/v3\/blocks\/0x102\/transactions/u)).toBe(1);
    // The polled head carried block 102's row.
    expect(getBlockRequests(chain).filter((request) => request.includes("102"))).toStrictEqual([]);
  });

  test("follows polled heads for block sources alone without transaction or block requests", async () => {
    const log: string[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine();
      },
      () => {
        chain.mine([logTx("tx-103")]);
      },
    ]);

    const exit = await runLive(testDb, [], {
      blocks: [loggedBlockSource(log, { interval: 1, startBlock: 100, endBlock: 103 })],
    });

    expect(exit).toStrictEqual(Exit.void);
    expect(log).toStrictEqual([
      "every 100 0x100",
      "every 101 0x101",
      "every 102 0x102",
      "every 103 0x103",
    ]);
    // Only the historical pass fetched a block; heads carry their rows.
    expect(getBlockRequests(chain)).toStrictEqual(["/extended/v2/blocks/100"]);
    expect(countRequests(chain, /^\/extended\/v3\//u)).toBe(0);
    expect(countRequests(chain, /\/logs\?/u)).toBe(0);
  });

  test("fetches a websocket head's block by hash when a block source runs at it", async () => {
    const contractIds = [CONTRACT_ID, "SP1.b", "SP1.c", "SP1.d", "SP1.e"];

    for (const contractId of contractIds.slice(1)) {
      await seedSynced(testDb, contractId);
    }

    const blocks: BlockEvent["block"][] = [];
    const originalWebSocket = globalThis.WebSocket;

    FakeWebSocket.instances.length = 0;
    vi.stubGlobal("WebSocket", FakeWebSocket);

    // Block 101 is mined while the subscription's catch-up poll is answered,
    // Which still serves block 100 (a lagging replica): 101 is only announced
    // Over the websocket, without its block row. The reader buffers the frame
    // Until the catch-up head is emitted.
    chain.onHeadPoll = () => {
      chain.onHeadPoll = undefined;
      chain.mine();
      chain.staleHeads.push(BASE_HEIGHT);

      const [head] = chain.blocks.slice(-1);

      FakeWebSocket.instances[0]?.receive(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "block",
          params: {
            height: head.height,
            hash: head.hash,
            parent_block_hash: head.parentHash,
            block_time: head.blockTime,
            tenure_height: head.height,
            txs: [],
          },
        }),
      );
    };

    try {
      const exit = await runLive(
        testDb,
        contractIds.map((contractId) => ({
          contractId,
          handler: () => Effect.void,
          endBlock: 101,
        })),
        {
          live: { transport: "websocket", pollingInterval: 100 },
          blocks: [
            {
              name: "every",
              interval: 1,
              startBlock: 100,
              endBlock: 101,
              handler: (event) =>
                Effect.sync(() => {
                  blocks.push(event.block);
                }),
            },
          ],
        },
      );

      expect(exit).toStrictEqual(Exit.void);
    } finally {
      vi.stubGlobal("WebSocket", originalWebSocket);
    }

    expect(FakeWebSocket.instances.map((socket) => socket.sent)).toStrictEqual([
      [JSON.stringify({ jsonrpc: "2.0", id: 1, method: "subscribe", params: { event: "block" } })],
    ]);
    expect(blocks.at(-1)).toStrictEqual({
      height: 101,
      time: 1010,
      hash: "0x101",
      indexBlockHash: "index-0x101",
    });
    expect(getBlockRequests(chain).filter((request) => request.includes("101"))).toStrictEqual([
      "/extended/v2/blocks/0x101",
    ]);
  });

  test("ends once every contract and block source reached its end block", async () => {
    const log: string[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101")]);
      },
      () => {
        chain.mine([logTx("tx-102")]);
      },
      () => {
        chain.mine();
      },
      () => {
        chain.mine();
      },
      () => {
        chain.mine();
      },
    ]);

    // The contract ends first; live follows the block source to 103.
    const exit = await runLive(
      testDb,
      [{ contractId: CONTRACT_ID, handler: logPrints(log), endBlock: 101 }],
      { blocks: [loggedBlockSource(log, { interval: 1, startBlock: 100, endBlock: 103 })] },
    );

    expect(exit).toStrictEqual(Exit.void);
    expect(log).toStrictEqual([
      "print 100 tx-100",
      "every 100 0x100",
      "print 101 tx-101",
      "every 101 0x101",
      "every 102 0x102",
      "every 103 0x103",
    ]);
    await expect(
      testDb.run(syncStore.getBlockSyncProgress({ chainId: 1, name: "every" })),
    ).resolves.toMatchObject({ syncedBlockHeight: 103n, isComplete: true });
  });

  test("replays block sources over the canonical blocks after a reorg", async () => {
    const log: string[] = [];

    scriptHeads(chain, [
      () => {
        chain.mine([logTx("tx-101-orphaned")]);
      },
      () => {
        chain.orphanFrom(101);
        chain.mine([logTx("tx-101-canonical")]);
        chain.mine([logTx("tx-102")]);
      },
    ]);

    const exit = await runLive(
      testDb,
      [{ contractId: CONTRACT_ID, handler: logPrints(log), endBlock: 102 }],
      { blocks: [loggedBlockSource(log, { interval: 1, startBlock: 100, endBlock: 102 })] },
    );

    expect(exit).toStrictEqual(Exit.void);
    expect(log).toStrictEqual([
      "print 100 tx-100",
      "every 100 0x100",
      "print 101 tx-101-orphaned",
      "every 101 0x101",
      "print 101 tx-101-canonical",
      "every 101 0x101-fork1",
      "print 102 tx-102",
      "every 102 0x102-fork1",
    ]);

    const stored = await testDb.run(
      syncStore.getStoredBlocks({ chainId: 1, fromBlockHeight: 101, toBlockHeight: 102 }),
    );

    expect(stored.map((block) => block.hash)).toStrictEqual(["0x101-fork1", "0x102-fork1"]);
  });
});
