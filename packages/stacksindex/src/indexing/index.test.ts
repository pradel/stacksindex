// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable vitest/prefer-called-once, vitest/no-conditional-expect, vitest/no-conditional-in-test

import type { ClarityAbi } from "clarity-abitype";
import { Effect, References } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import type { StacksClientService } from "../datasources/api/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import type { HandlerContext, HandlerEvent, Handlers } from "../lib/types.ts";
import { blocksTable } from "../sync-store/schema.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { createIndexing } from "./index.ts";

const notUsed = () => Effect.die("StacksClient method not used in this test");

const makeStacksClient = (overrides: Partial<StacksClientService> = {}): StacksClientService => ({
  getStatus: notUsed,
  getBlock: notUsed,
  getBlockTransactions: notUsed,
  getTransaction: notUsed,
  getV1Transaction: notUsed,
  getTransactionsBatch: notUsed,
  getTransactionEvents: notUsed,
  getPrincipalTransactions: notUsed,
  getContract: notUsed,
  getContractLogs: notUsed,
  callReadFunction: notUsed,
  ...overrides,
});

// SAFETY: Tests in the "indexing engine" suite never call database methods, so an empty
// Object satisfies the service type they provide as `IndexerDatabase`.
const mockDb = {} as IndexerDb;

const testAbi = {
  functions: [
    {
      name: "get-decimals",
      access: "read_only",
      args: [],
      outputs: {
        type: {
          response: {
            ok: "uint128",
            error: "none",
          },
        },
      },
    },
  ],
  variables: [],
  maps: [],
  fungible_tokens: [],
  non_fungible_tokens: [],
} as const satisfies ClarityAbi;

const createMockEvent = (overrides: Partial<HandlerEvent> = {}): HandlerEvent => ({
  event_index: 0,
  event_type: "smart_contract_log",
  tx_id: "tx-1",
  contract_log: {
    contract_id: "SP123.token",
    topic: "print",
    value: { hex: "0x01", repr: "(ok true)" },
  },
  block_height: 100,
  block_time: 1000,
  tx_index: 0,
  sender_address: "SP sender",
  ...overrides,
});

const runBatch = (
  indexing: ReturnType<typeof createIndexing>,
  events: HandlerEvent[],
  db: IndexerDb,
) =>
  Effect.runPromise(
    indexing
      .executeBatch(events)
      .pipe(
        Effect.provideService(IndexerDatabase, db),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
  );

describe("indexing engine", () => {
  test("calls matching handler with event and context containing db and client", async () => {
    const handler = vi.fn().mockReturnValue(Effect.void);

    const handlers: Handlers = {
      "SP123.token": handler,
    };

    const indexing = createIndexing({ handlers, client: makeStacksClient() });

    const event = createMockEvent();
    await runBatch(indexing, [event], mockDb);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        db: mockDb,
        client: expect.objectContaining({
          callReadOnly: expect.any(Function),
        }),
      }),
    );
  });

  test("client.callReadOnly injects event block_height as tip", async () => {
    const callReadFunction = vi
      .fn()
      .mockReturnValue(
        Effect.succeed({ okay: true, result: "0x0100000000000000000000000000000001" }),
      );

    const handler = vi.fn().mockImplementation((_event, ctx: HandlerContext) =>
      Effect.gen(function* () {
        // Call without explicit tip - should inject event.block_height
        yield* ctx.client.callReadOnly({
          contractId: "SP123.contract",
          functionName: "get-something",
          args: ["0x01"],
          senderAddress: "ST123",
        });

        // Call with explicit options.tip - should use explicit tip
        yield* ctx.client.callReadOnly({
          contractId: "SP123.contract",
          functionName: "get-something",
          tip: 99999,
        });

        // Call without options tip - should default tip to event.block_height
        yield* ctx.client.callReadOnly({
          contractId: "SP123.contract",
          functionName: "get-something",
        });
      }),
    );

    const handlers: Handlers = {
      "SP123.token": handler,
    };

    const event = createMockEvent({ block_height: 54321 });
    const stacksClient = makeStacksClient({ callReadFunction });
    const indexing = createIndexing({ handlers, client: stacksClient });

    await runBatch(indexing, [event], mockDb);

    expect(handler).toHaveBeenCalledTimes(1);

    expect(callReadFunction).toHaveBeenNthCalledWith(1, "SP123.contract", "get-something", {
      args: ["0x01"],
      sender: "ST123",
      tip: 54321,
    });

    expect(callReadFunction).toHaveBeenNthCalledWith(2, "SP123.contract", "get-something", {
      args: [],
      sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      tip: 99999,
    });

    expect(callReadFunction).toHaveBeenNthCalledWith(3, "SP123.contract", "get-something", {
      args: [],
      sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      tip: 54321,
    });
  });

  test("client.callReadOnly supports typed ABI options and injects event block_height as tip", async () => {
    const callReadFunction = vi.fn().mockReturnValue(
      Effect.succeed({
        okay: true,
        // ResponseOk(UInt(42))
        result: "0x07010000000000000000000000000000002a",
      }),
    );

    let handlerResult: unknown;

    const handler = vi.fn().mockImplementation((_event, ctx: HandlerContext) =>
      Effect.gen(function* () {
        handlerResult = yield* ctx.client.callReadOnly({
          abi: testAbi,
          contractId: "SP123.contract",
          functionName: "get-decimals",
        });
      }),
    );

    const handlers: Handlers = {
      "SP123.token": handler,
    };

    const event = createMockEvent({ block_height: 77777 });
    const stacksClient = makeStacksClient({ callReadFunction });
    const indexing = createIndexing({ handlers, client: stacksClient });

    await runBatch(indexing, [event], mockDb);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handlerResult).toStrictEqual({ ok: 42n });

    expect(callReadFunction).toHaveBeenCalledWith("SP123.contract", "get-decimals", {
      args: [],
      sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      tip: 77777,
    });
  });

  test("returns ok when no handler matches contract", async () => {
    const handlers: Handlers = {};

    const event = createMockEvent();
    const indexing = createIndexing({ handlers, client: makeStacksClient() });

    await runBatch(indexing, [event], mockDb);
  });

  test("returns err when handler throws", async () => {
    const error = new Error("Handler failed");
    const handler = vi.fn().mockReturnValue(Effect.fail(error));

    const handlers: Handlers = {
      "SP123.token": handler,
    };

    const event = createMockEvent();
    const indexing = createIndexing({ handlers, client: makeStacksClient() });

    const result = await Effect.runPromiseExit(
      indexing
        .executeBatch([event])
        .pipe(
          Effect.provideService(IndexerDatabase, mockDb),
          Effect.provideService(References.MinimumLogLevel, "None"),
        ),
    );

    expect(result).toBeTaggedError(
      new HandlerExecutionError({ contractId: "SP123.token", cause: error }),
    );
  });
});

describe("transactional event handlers", () => {
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

  const insertBlock = (context: HandlerContext) =>
    context.db
      .insert(blocksTable)
      .values({
        chainId: 1n,
        height: 100n,
        hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
        blockTime: 1000n,
        tenureHeight: 1n,
      })
      .pipe(Effect.asVoid);

  const runBatchInTransaction = (
    indexing: ReturnType<typeof createIndexing>,
    events: HandlerEvent[],
  ) =>
    Effect.runPromise(
      IndexerDatabase.transaction(() => indexing.executeBatch(events)).pipe(
        Effect.provideService(IndexerDatabase, testDb.db),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

  test("commits handler writes together with the event", async () => {
    const handler = vi
      .fn()
      .mockImplementation((_event: HandlerEvent, context: HandlerContext) => insertBlock(context));

    const indexing = createIndexing({
      handlers: { "SP123.token": handler },
      client: makeStacksClient(),
    });

    await runBatchInTransaction(indexing, [createMockEvent()]);

    await expect(testDb.db.select().from(blocksTable)).resolves.toHaveLength(1);
  });

  test("rolls back handler writes when the handler throws", async () => {
    const error = new Error("Handler failed");

    const handler = vi
      .fn()
      .mockImplementation((_event: HandlerEvent, context: HandlerContext) =>
        insertBlock(context).pipe(Effect.andThen(Effect.fail(error))),
      );

    const indexing = createIndexing({
      handlers: { "SP123.token": handler },
      client: makeStacksClient(),
    });

    const result = await Effect.runPromiseExit(
      IndexerDatabase.transaction(() => indexing.executeBatch([createMockEvent()])).pipe(
        Effect.provideService(IndexerDatabase, testDb.db),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

    expect(result).toBeTaggedError(
      new HandlerExecutionError({ contractId: "SP123.token", cause: error }),
    );
    await expect(testDb.db.select().from(blocksTable)).resolves.toHaveLength(0);
  });
});
