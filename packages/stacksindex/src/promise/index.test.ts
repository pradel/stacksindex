import { Effect, Schema } from "effect";
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

import { pglite } from "../database/index.ts";
import { ConfigurationError, EventDecodeError } from "../lib/errors.ts";
import type { BlockEvent, PrintEvent } from "../lib/types.ts";
import { syncProgressTable } from "../sync-store/schema.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { freshDatabase } from "../test/fresh-database.ts";
import { type BlockHandler, defineIndexer, type Indexer } from "./index.ts";

const CONTRACT_ID = "SP123.token";

const BASE_HEIGHT = 100;

/** Marks the contract synced below the tip, so `run` catches up block 100 without discovery. */
const seedProgress = (indexer: Indexer) =>
  indexer.db.insert(syncProgressTable).values({
    chainId: 1n,
    contractId: CONTRACT_ID,
    cursor: null,
    syncedBlockHeight: BigInt(BASE_HEIGHT - 1),
  });

describe("promise indexer", () => {
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

  test("parses event.data with the contract's Standard Schema print", async () => {
    const Print = Schema.Struct({
      ok: Schema.Boolean,
      source: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("print"))),
    });

    const received: unknown[] = [];

    await using indexer = await defineIndexer({
      contracts: { token: { id: CONTRACT_ID, print: Schema.toStandardSchemaV1(Print) } },
    }).create({
      database: await freshDatabase(),
      logLevel: "None",
      handlers: {
        token: (event) => {
          expectTypeOf(event.data).toEqualTypeOf<{
            readonly ok: boolean;
            readonly source: string;
          }>();
          received.push(event.data);
        },
      },
    });

    await seedProgress(indexer);

    await expect(indexer.run()).resolves.toMatchObject({
      eventsProcessed: 1,
      contracts: { token: { eventsProcessed: 1 } },
    });
    expect(received).toStrictEqual([{ ok: true, source: "print" }]);
  });

  test("fails the run with EventDecodeError naming the path of each schema issue", async () => {
    const handler = vi.fn();

    await using indexer = await defineIndexer({
      contracts: {
        token: {
          id: CONTRACT_ID,
          print: Schema.toStandardSchemaV1(Schema.Struct({ ok: Schema.String })),
        },
      },
    }).create({ database: await freshDatabase(), logLevel: "None", handlers: { token: handler } });

    await seedProgress(indexer);

    const run = indexer.run();

    await expect(run).rejects.toBeInstanceOf(EventDecodeError);
    await expect(run).rejects.toMatchObject({
      contract: "token",
      contractId: CONTRACT_ID,
      txId: "tx-100",
      eventIndex: 0,
      message: expect.stringMatching(/^ok: /u),
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("create rejects with ConfigurationError when a contract has no handler", async () => {
    const definition = defineIndexer({
      contracts: { token: { id: CONTRACT_ID }, pool: { id: "SP123.pool" } },
    });

    await expect(
      definition.create({
        database: pglite(),
        logLevel: "None",
        // @ts-expect-error -- every defined contract needs a handler
        handlers: { token: () => undefined },
      }),
    ).rejects.toStrictEqual(new ConfigurationError({ message: "handlers.pool: missing handler." }));
  });

  test("create rejects with ConfigurationError for a handler without a contract or block source", async () => {
    const definition = defineIndexer({
      contracts: { token: { id: CONTRACT_ID } },
      blocks: { every: { startBlock: BASE_HEIGHT } },
    });

    await expect(
      definition.create({
        database: pglite(),
        logLevel: "None",
        handlers: {
          token: () => undefined,
          every: () => undefined,
          // @ts-expect-error -- `pool` is not a defined contract or block source
          pool: () => undefined,
        },
      }),
    ).rejects.toStrictEqual(
      new ConfigurationError({
        message: 'handlers.pool: no contract or block source named "pool".',
      }),
    );
  });

  test("create rejects with ConfigurationError when a block source has no handler", async () => {
    const definition = defineIndexer({
      contracts: { token: { id: CONTRACT_ID } },
      blocks: { every: { startBlock: BASE_HEIGHT } },
    });

    await expect(
      definition.create({
        database: pglite(),
        logLevel: "None",
        // @ts-expect-error -- every defined block source needs a handler
        handlers: { token: () => undefined },
      }),
    ).rejects.toStrictEqual(
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
    expect(() => defineIndexer({ blocks: { every: { interval: 0, startBlock: 1 } } })).toThrow(
      new ConfigurationError({
        message: "blocks.every: `interval` must be a positive integer, got 0.",
      }),
    );
  });

  test("block handlers get the block and a client pinned to it", async () => {
    const definition = defineIndexer({ blocks: { every: { startBlock: BASE_HEIGHT } } });
    const received: BlockEvent[] = [];

    await using indexer = await definition.create({
      database: await freshDatabase(),
      logLevel: "None",
      handlers: {
        every: async (event, { client }) => {
          expectTypeOf(event).toEqualTypeOf<BlockEvent>();
          received.push(event);
          await client.callReadOnly({ contractId: CONTRACT_ID, functionName: "get-total-supply" });
        },
      },
    });

    await expect(indexer.run()).resolves.toMatchObject({
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
    await expect(indexer.status()).resolves.toMatchObject({
      blocks: { every: { syncedBlockHeight: BASE_HEIGHT, isComplete: false } },
    });
  });

  test("types handlers by source: block sources get BlockEvent and are required", () => {
    const definition = defineIndexer({
      contracts: { token: { id: CONTRACT_ID } },
      blocks: { every: { startBlock: BASE_HEIGHT } },
    });

    definition.handler("every", (event) => {
      expectTypeOf(event).toEqualTypeOf<BlockEvent>();
    });
    definition.handler("token", (event) => {
      expectTypeOf(event).toEqualTypeOf<PrintEvent>();
    });

    type CreateHandlers = Parameters<typeof definition.create>[0]["handlers"];

    expectTypeOf<CreateHandlers["every"]>().toEqualTypeOf<BlockHandler>();
  });

  test("defineIndexer throws ConfigurationError for an invalid definition", () => {
    expect(() => defineIndexer({ contracts: { token: { id: "token" } } })).toThrow(
      ConfigurationError,
    );
  });
});
