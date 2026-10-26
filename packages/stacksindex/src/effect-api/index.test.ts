import { defineRelations, sql } from "drizzle-orm";
import { pgTable, text } from "drizzle-orm/pg-core";
import { Context, Effect, Layer, Option, Schema } from "effect";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  test,
  vi,
} from "vite-plus/test";

import { IndexerDatabase, type IndexerDb, pglite } from "../database/index.ts";
import {
  ConfigurationError,
  type DatabaseError,
  HandlerExecutionError,
  type MigrationError,
} from "../lib/errors.ts";
import type { BlockEvent } from "../lib/types.ts";
import { Indexer } from "../runtime/index.ts";
import { syncStore } from "../sync-store/index.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { freshDatabase } from "../test/fresh-database.ts";
import { defineIndexer } from "./index.ts";

const CONTRACT_ID = "SP123.token";

const BASE_HEIGHT = 100;

class Greeting extends Context.Service<Greeting, { readonly prefix: string }>()("test/Greeting") {}

const greetingsTable = pgTable("greetings", {
  txId: text("tx_id").primaryKey(),
  message: text().notNull(),
});

const relations = defineRelations({ greetingsTable });

// oxlint-disable-next-line typescript/no-explicit-any
type LayerRequirements<L> = L extends Layer.Layer<any, any, infer R> ? R : never;

/**
 * Creates the user table and marks the contract synced below the tip, then
 * runs once and returns the stored greetings, or the run's failure.
 */
const runOnce = Effect.gen(function* () {
  const db = yield* IndexerDatabase;

  yield* db.execute(
    sql`create table "greetings" ("tx_id" text primary key, "message" text not null)`,
  );
  yield* syncStore.upsertSyncProgress({
    contractId: CONTRACT_ID,
    chainId: 1,
    cursor: null,
    syncedBlockHeight: BASE_HEIGHT - 1,
  });

  const indexer = yield* Indexer;
  const failure = yield* indexer.run.pipe(Effect.flip, Effect.option);
  const greetings = yield* db.select().from(greetingsTable);

  return { failure, greetings };
});

describe("effect indexer", () => {
  // oxlint-disable-next-line init-declarations
  let chain: FakeChain;
  /** Read-only calls, as decoded `pathname?search`. */
  let callReads: string[] = [];

  beforeAll(() => {
    // The HTTP client may keep the first `fetch` it sees; delegate to the current test's chain.
    vi.stubGlobal("fetch", (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input);

      if (url.pathname.startsWith("/v2/contracts/call-read/")) {
        callReads.push(decodeURIComponent(`${url.pathname}${url.search}`));

        // Every read-only call answers `(ok true)`.
        return Promise.resolve(Response.json({ okay: true, result: "0x0703" }));
      }

      return chain.fetch(input);
    });
  });

  beforeEach(() => {
    callReads = [];
    chain = createFakeChain({ baseHeight: BASE_HEIGHT - 1 });
    // Prints `(ok true)`.
    chain.mine([{ txId: "tx-100", events: [{ contractId: CONTRACT_ID, eventIndex: 0 }] }]);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  const definition = defineIndexer({ relations, contracts: { token: { id: CONTRACT_ID } } });

  const greetingLayer = Layer.succeed(Greeting, { prefix: "gm" });

  test("handlers get the layer's services and write through the batch transaction", async () => {
    const handler = definition.handler("token", (event) =>
      Effect.gen(function* () {
        const db = yield* definition.Db;
        const { prefix } = yield* Greeting;

        yield* db
          .insert(greetingsTable)
          .values({ txId: event.txId, message: `${prefix} ${event.txId}` });
      }),
    );

    const layer = definition.layer({
      database: await freshDatabase(),
      logLevel: "None",
      handlers: { token: handler },
    });

    const result = await Effect.runPromise(
      runOnce.pipe(Effect.provide(layer), Effect.provide(greetingLayer)),
    );

    expect(Option.getOrUndefined(result.failure)).toBeUndefined();
    expect(result.greetings).toStrictEqual([{ txId: "tx-100", message: "gm tx-100" }]);
  });

  test("a failing handler rolls back its write", async () => {
    const boom = new Error("boom");

    const handler = definition.handler("token", (event) =>
      Effect.gen(function* () {
        const db = yield* definition.Db;
        const { prefix } = yield* Greeting;

        yield* db.insert(greetingsTable).values({ txId: event.txId, message: prefix });

        return yield* Effect.fail(boom);
      }),
    );

    const result = await Effect.runPromise(
      runOnce.pipe(
        Effect.provide(
          definition.layer({
            database: await freshDatabase(),
            logLevel: "None",
            handlers: { token: handler },
          }),
        ),
        Effect.provide(greetingLayer),
      ),
    );

    expect(result.greetings).toStrictEqual([]);
    const failure = Option.getOrUndefined(result.failure);

    expect(failure).toBeInstanceOf(HandlerExecutionError);
    expect(failure).toMatchObject({ contract: "token", contractId: CONTRACT_ID, cause: boom });
  });

  test("decodes event.data with the contract's Effect Schema print", async () => {
    const Print = Schema.Struct({
      ok: Schema.Boolean,
      source: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("print"))),
    });

    const withPrint = defineIndexer({ contracts: { token: { id: CONTRACT_ID, print: Print } } });
    const received: unknown[] = [];

    const handler = withPrint.handler("token", (event) => {
      expectTypeOf(event.data).toEqualTypeOf<{ readonly ok: boolean; readonly source: string }>();

      return Effect.sync(() => {
        received.push(event.data);
      });
    });

    await Effect.runPromise(
      runOnce.pipe(
        Effect.provide(
          withPrint.layer({
            database: await freshDatabase(),
            logLevel: "None",
            handlers: { token: handler },
          }),
        ),
      ),
    );

    expect(received).toStrictEqual([{ ok: true, source: "print" }]);
  });

  test("layer fails with ConfigurationError for a handler without a contract", async () => {
    const layer = definition.layer({
      database: pglite(),
      logLevel: "None",
      // @ts-expect-error -- `pool` is not a defined contract; JavaScript callers still get a ConfigurationError.
      handlers: { token: () => Effect.void, pool: () => Effect.void },
    });

    const error = await Effect.runPromise(Effect.flip(Layer.build(layer).pipe(Effect.scoped)));

    expect(error).toStrictEqual(
      new ConfigurationError({
        message: 'handlers.pool: no contract or block source named "pool".',
      }),
    );
  });

  const withBlocks = defineIndexer({
    contracts: { token: { id: CONTRACT_ID } },
    blocks: { every: { startBlock: BASE_HEIGHT } },
  });

  test("layer fails with ConfigurationError when a block source has no handler", async () => {
    const layer = withBlocks.layer({
      database: pglite(),
      logLevel: "None",
      // @ts-expect-error -- every defined block source needs a handler
      handlers: { token: () => Effect.void },
    });

    const error = await Effect.runPromise(
      // SAFETY: The rejected `handlers` leave the requirements `any`; building the layer needs none.
      Effect.flip(Layer.build(layer).pipe(Effect.scoped)) as Effect.Effect<ConfigurationError>,
    );

    expect(error).toStrictEqual(
      new ConfigurationError({ message: "handlers.every: missing handler." }),
    );
  });

  test("defineIndexer rejects a block source reusing a contract name or with an invalid interval", () => {
    expect(() =>
      defineIndexer({
        contracts: { token: { id: CONTRACT_ID } },
        blocks: { token: { startBlock: BASE_HEIGHT } },
      }),
    ).toThrow(
      new ConfigurationError({
        message:
          "blocks.token: the name is already used by contracts.token; names must be unique across `contracts` and `blocks`.",
      }),
    );
    expect(() => defineIndexer({ blocks: { every: { interval: 1.5, startBlock: 1 } } })).toThrow(
      new ConfigurationError({
        message: "blocks.every: `interval` must be a positive integer, got 1.5.",
      }),
    );
  });

  test("block handlers get the block and a client pinned to it", async () => {
    const blocksOnly = defineIndexer({ blocks: { every: { startBlock: BASE_HEIGHT } } });
    const received: BlockEvent[] = [];

    const handler = blocksOnly.handler("every", (event) =>
      Effect.gen(function* () {
        expectTypeOf(event).toEqualTypeOf<BlockEvent>();
        received.push(event);

        const client = yield* blocksOnly.Client;

        yield* client.callReadOnly({ contractId: CONTRACT_ID, functionName: "get-total-supply" });
      }),
    );

    const { result, status } = await Effect.runPromise(
      Effect.gen(function* () {
        const indexer = yield* Indexer;

        return { result: yield* indexer.run, status: yield* indexer.status };
      }).pipe(
        Effect.provide(
          blocksOnly.layer({
            database: await freshDatabase(),
            logLevel: "None",
            handlers: { every: handler },
          }),
        ),
      ),
    );

    expect(result).toMatchObject({
      eventsProcessed: 1,
      blocks: { every: { eventsProcessed: 1, blockHeight: BASE_HEIGHT } },
    });
    expect(received).toStrictEqual([
      {
        type: "block",
        name: "every",
        block: { height: 100, time: 1000, hash: "0x100", indexBlockHash: "index-0x100" },
      },
    ]);
    expect(callReads).toStrictEqual([
      "/v2/contracts/call-read/SP123/token/get-total-supply?tip=index-0x100",
    ]);
    expect(status.blocks).toStrictEqual({
      every: { syncedBlockHeight: BASE_HEIGHT, isComplete: false },
    });
  });

  test("types block source handlers with BlockEvent", () => {
    withBlocks.handler("every", (event) => {
      expectTypeOf(event).toEqualTypeOf<BlockEvent>();

      return Effect.void;
    });

    const layer = withBlocks.layer({
      database: pglite(),
      handlers: {
        token: () => Effect.void,
        every: (event) => {
          expectTypeOf(event).toEqualTypeOf<BlockEvent>();

          return Effect.gen(function* () {
            yield* Greeting;
          });
        },
      },
    });

    expectTypeOf<LayerRequirements<typeof layer>>().toEqualTypeOf<Greeting>();
  });

  test("types Db by the relations and requires the handlers' extra services", () => {
    expectTypeOf(definition.Db).toEqualTypeOf<
      Effect.Effect<IndexerDb<typeof relations>, never, IndexerDatabase>
    >();

    const withGreeting = definition.layer({
      database: pglite(),
      handlers: {
        token: () =>
          Effect.gen(function* () {
            yield* definition.Db;
            yield* definition.Client;
            yield* Greeting;
          }),
      },
    });

    expectTypeOf<LayerRequirements<typeof withGreeting>>().toEqualTypeOf<Greeting>();
    expectTypeOf(withGreeting).toEqualTypeOf<
      Layer.Layer<
        Indexer | IndexerDatabase,
        ConfigurationError | DatabaseError | MigrationError,
        Greeting
      >
    >();

    const selfContained = definition.layer({
      database: pglite(),
      handlers: { token: () => definition.Db.pipe(Effect.asVoid) },
    });

    expectTypeOf<LayerRequirements<typeof selfContained>>().toEqualTypeOf<never>();
  });
});
