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
import { syncProgressTable } from "../sync-store/schema.ts";
import { createFakeChain, type FakeChain } from "../test-utils/fake-chain.ts";
import { defineIndexer, type Indexer } from "./index.ts";

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

  beforeAll(() => {
    // The HTTP client may keep the first `fetch` it sees; delegate to the current test's chain.
    vi.stubGlobal("fetch", (input: string | URL | Request) => chain.fetch(input));
  });

  beforeEach(() => {
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
      database: pglite(),
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
    }).create({ database: pglite(), logLevel: "None", handlers: { token: handler } });

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

  test("create rejects with ConfigurationError for a handler without a contract", async () => {
    const definition = defineIndexer({ contracts: { token: { id: CONTRACT_ID } } });

    await expect(
      definition.create({
        database: pglite(),
        logLevel: "None",
        handlers: {
          token: () => undefined,
          // @ts-expect-error -- `pool` is not a defined contract
          pool: () => undefined,
        },
      }),
    ).rejects.toStrictEqual(
      new ConfigurationError({ message: 'handlers.pool: no contract named "pool".' }),
    );
  });

  test("defineIndexer throws ConfigurationError for an invalid definition", () => {
    expect(() => defineIndexer({ contracts: { token: { id: "token" } } })).toThrow(
      ConfigurationError,
    );
  });
});
