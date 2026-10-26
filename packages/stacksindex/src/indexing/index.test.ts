// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable vitest/prefer-called-once, vitest/no-conditional-expect, vitest/no-conditional-in-test

import type { ClarityAbi } from "clarity-abitype";
import { Effect, Exit, Metric, Option, References, Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { ClarityJsonValue } from "../codec/index.ts";
import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import type { StacksClientService } from "../datasources/api/index.ts";
import { EventDecodeError, HandlerExecutionError } from "../lib/errors.ts";
import { contractAttributes, indexingHandlerErrors } from "../lib/metrics.ts";
import type { CoreHandler, PrintEvent } from "../lib/types.ts";
import type { ResolvedContract } from "../runtime/contracts.ts";
import type { StoredEvent } from "../sync-store/decode.ts";
import { blocksTable } from "../sync-store/schema.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { HandlerClient } from "./client.ts";
import { createIndexing, type IndexingService } from "./index.ts";

const notUsed = () => Effect.die("StacksClient method not used in this test");

const makeStacksClient = (overrides: Partial<StacksClientService> = {}): StacksClientService => ({
  getStatus: notUsed,
  getBlocks: notUsed,
  getBlock: notUsed,
  getStacksBlocks: notUsed,
  getBitcoinBlocks: notUsed,
  getBlockTransactions: notUsed,
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

const CONTRACT_ID = "SP123.token";

/** `(ok true)` */
const OK_TRUE_HEX = "0x0703";

/** `(ok false)` */
const OK_FALSE_HEX = "0x0704";

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

const tokenContract = (
  handler: CoreHandler,
  overrides: Partial<ResolvedContract> = {},
): ResolvedContract => ({
  name: "token",
  contractId: CONTRACT_ID,
  onInvalid: "fail",
  handler,
  ...overrides,
});

const createStoredEvent = (overrides: Partial<StoredEvent> = {}): StoredEvent => ({
  eventIndex: 0,
  eventType: "smart_contract_log",
  txId: "tx-1",
  contractId: CONTRACT_ID,
  topic: "print",
  valueHex: OK_TRUE_HEX,
  valueRepr: "(ok true)",
  blockHeight: 100n,
  blockTime: 1000n,
  blockHash: "0xblock-100",
  indexBlockHash: "0xindex-100",
  txIndex: 0,
  senderAddress: "SP sender",
  ...overrides,
});

const runBatchExit = (indexing: IndexingService, events: StoredEvent[]) =>
  Effect.runPromiseExit(
    indexing
      .executeBatch(events)
      .pipe(
        Effect.provideService(IndexerDatabase, mockDb),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
  );

const runBatch = async (indexing: IndexingService, events: StoredEvent[]) => {
  const exit = await runBatchExit(indexing, events);

  if (Exit.isFailure(exit)) {
    throw new Error("Expected the batch to succeed", { cause: exit.cause });
  }

  return exit.value;
};

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

describe("indexing engine", () => {
  test("calls the contract's handler with the print event and counts it", async () => {
    const handler = vi.fn<CoreHandler>().mockReturnValue(Effect.void);

    const indexing = createIndexing({
      contracts: [tokenContract(handler)],
      client: makeStacksClient(),
    });

    const counts = await runBatch(indexing, [createStoredEvent()]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toStrictEqual({
      type: "print",
      contract: "token",
      contractId: CONTRACT_ID,
      txId: "tx-1",
      eventIndex: 0,
      data: { ok: true },
      raw: { hex: OK_TRUE_HEX, repr: "(ok true)", topic: "print" },
      block: { height: 100, time: 1000, hash: "0xblock-100", indexBlockHash: "0xindex-100" },
      tx: { index: 0, sender: "SP sender" },
    } satisfies PrintEvent);
    expect(counts).toStrictEqual(new Map([["token", 1]]));
  });

  test("the handler client pins calls to the event's index block hash", async () => {
    const callReadFunction = vi
      .fn()
      .mockReturnValue(
        Effect.succeed({ okay: true, result: "0x0100000000000000000000000000000001" }),
      );

    // `getBlock` stays `notUsed`: the tip comes from the event, not a block lookup.
    const handler = vi.fn<CoreHandler>().mockReturnValue(
      Effect.gen(function* () {
        const client = yield* HandlerClient;

        // Without a tip: the event's block.
        yield* client.callReadOnly({
          contractId: "SP123.contract",
          functionName: "get-something",
          args: ["0x01"],
          senderAddress: "ST123",
        });

        // An explicit tip overrides the event's index block hash.
        yield* client.callReadOnly({
          contractId: "SP123.contract",
          functionName: "get-something",
          tip: "0xexplicit",
        });
      }),
    );

    const indexing = createIndexing({
      contracts: [tokenContract(handler)],
      client: makeStacksClient({ callReadFunction }),
    });

    await runBatch(indexing, [
      createStoredEvent({ blockHeight: 54321n, indexBlockHash: "0xindex-54321", eventIndex: 0 }),
      createStoredEvent({ blockHeight: 54321n, indexBlockHash: "0xindex-54321", eventIndex: 1 }),
    ]);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(callReadFunction.mock.calls.slice(0, 2)).toStrictEqual([
      [
        "SP123.contract",
        "get-something",
        { args: ["0x01"], sender: "ST123", tip: "0xindex-54321" },
      ],
      [
        "SP123.contract",
        "get-something",
        { args: [], sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", tip: "0xexplicit" },
      ],
    ]);
    expect(callReadFunction.mock.calls.slice(2)).toStrictEqual(
      callReadFunction.mock.calls.slice(0, 2),
    );
  });

  test("the handler client supports typed ABI options and pins them to the event's index block hash", async () => {
    const callReadFunction = vi.fn().mockReturnValue(
      Effect.succeed({
        okay: true,
        // ResponseOk(UInt(42))
        result: "0x07010000000000000000000000000000002a",
      }),
    );

    let handlerResult: unknown;

    const handler = vi.fn<CoreHandler>().mockImplementation(() =>
      Effect.gen(function* () {
        const client = yield* HandlerClient;

        handlerResult = yield* client.callReadOnly({
          abi: testAbi,
          contractId: "SP123.contract",
          functionName: "get-decimals",
        });
      }),
    );

    const indexing = createIndexing({
      contracts: [tokenContract(handler)],
      client: makeStacksClient({ callReadFunction }),
    });

    await runBatch(indexing, [
      createStoredEvent({ blockHeight: 77777n, indexBlockHash: "0xindex-77777" }),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handlerResult).toStrictEqual({ ok: 42n });

    expect(callReadFunction).toHaveBeenCalledWith("SP123.contract", "get-decimals", {
      args: [],
      sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
      tip: "0xindex-77777",
    });
  });

  test("skips events of contracts it does not index", async () => {
    const handler = vi.fn<CoreHandler>().mockReturnValue(Effect.void);

    const indexing = createIndexing({
      contracts: [tokenContract(handler)],
      client: makeStacksClient(),
    });

    const counts = await runBatch(indexing, [createStoredEvent({ contractId: "SP456.other" })]);

    expect(handler).not.toHaveBeenCalled();
    expect(counts).toStrictEqual(new Map());
  });

  test("fails with HandlerExecutionError when the handler fails", async () => {
    const error = new Error("Handler failed");

    const indexing = createIndexing({
      contracts: [tokenContract(() => Effect.fail(error))],
      client: makeStacksClient(),
    });

    const result = await runBatchExit(indexing, [createStoredEvent()]);

    expect(result).toBeTaggedError(
      new HandlerExecutionError({ contract: "token", contractId: CONTRACT_ID, cause: error }),
    );
  });

  test("counts failed handler calls per contract, labelled by name and id", async () => {
    const indexing = createIndexing({
      contracts: [
        tokenContract(() => Effect.fail(new Error("Handler failed"))),
        tokenContract(() => Effect.void, { name: "other", contractId: "SP456.other" }),
      ],
      client: makeStacksClient(),
    });

    const [tokenErrors, otherErrors] = await Effect.runPromise(
      Effect.gen(function* () {
        yield* indexing
          .executeBatch([createStoredEvent({ contractId: "SP456.other" }), createStoredEvent()])
          .pipe(Effect.ignore);

        return [
          yield* Metric.value(
            Metric.withAttributes(indexingHandlerErrors, contractAttributes("token", CONTRACT_ID)),
          ),
          yield* Metric.value(
            Metric.withAttributes(
              indexingHandlerErrors,
              contractAttributes("other", "SP456.other"),
            ),
          ),
        ];
      }).pipe(
        Effect.provideService(IndexerDatabase, mockDb),
        Effect.provideService(Metric.MetricRegistry, new Map()),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

    expect(tokenErrors.count).toBe(1);
    expect(otherErrors.count).toBe(0);
  });
});

describe("print decoding", () => {
  /** Accepts `(ok true)` only, as a contract `print` schema would. */
  const okTrueOnly = (value: ClarityJsonValue) =>
    Schema.decodeUnknownEffect(Schema.Struct({ ok: Schema.Literal(true) }))(value).pipe(
      Effect.as({ accepted: true }),
      Effect.mapError((cause) => ({ message: "ok: Expected true", cause })),
    );

  test("hands the decoded data to the handler", async () => {
    const handler = vi.fn<CoreHandler>().mockReturnValue(Effect.void);

    const indexing = createIndexing({
      contracts: [tokenContract(handler, { decode: okTrueOnly })],
      client: makeStacksClient(),
    });

    await runBatch(indexing, [createStoredEvent()]);

    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ data: { accepted: true } }));
  });

  test('fails the batch with EventDecodeError on a mismatch when onInvalid is "fail"', async () => {
    const handler = vi.fn<CoreHandler>().mockReturnValue(Effect.void);

    const indexing = createIndexing({
      contracts: [tokenContract(handler, { decode: okTrueOnly })],
      client: makeStacksClient(),
    });

    const exit = await runBatchExit(indexing, [
      createStoredEvent({ txId: "tx-bad", eventIndex: 3, valueHex: OK_FALSE_HEX }),
    ]);

    const failure = failureOf(exit);

    expect(failure).toBeInstanceOf(EventDecodeError);
    expect(failure).toMatchObject({
      contract: "token",
      contractId: CONTRACT_ID,
      txId: "tx-bad",
      eventIndex: 3,
      message: "ok: Expected true",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test('skips a mismatching print without counting it when onInvalid is "skip"', async () => {
    const handler = vi.fn<CoreHandler>().mockReturnValue(Effect.void);

    const indexing = createIndexing({
      contracts: [tokenContract(handler, { decode: okTrueOnly, onInvalid: "skip" })],
      client: makeStacksClient(),
    });

    const counts = await runBatch(indexing, [
      createStoredEvent({ txId: "tx-bad", valueHex: OK_FALSE_HEX }),
      createStoredEvent({ txId: "tx-good" }),
    ]);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ txId: "tx-good" }));
    expect(counts).toStrictEqual(new Map([["token", 1]]));
  });

  test("treats a value that is not valid Clarity as a decode issue", async () => {
    const handler = vi.fn<CoreHandler>().mockReturnValue(Effect.void);
    const invalid = createStoredEvent({ txId: "tx-garbage", valueHex: "0xff" });

    const failing = createIndexing({
      contracts: [tokenContract(handler)],
      client: makeStacksClient(),
    });

    const failure = failureOf(await runBatchExit(failing, [invalid]));

    expect(failure).toBeInstanceOf(EventDecodeError);
    expect(failure).toMatchObject({
      contract: "token",
      txId: "tx-garbage",
      message: "Not a valid Clarity value",
    });

    const skipping = createIndexing({
      contracts: [tokenContract(handler, { onInvalid: "skip" })],
      client: makeStacksClient(),
    });

    await expect(runBatch(skipping, [invalid])).resolves.toStrictEqual(new Map());
    expect(handler).not.toHaveBeenCalled();
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

  const insertBlock = Effect.gen(function* () {
    const db = yield* IndexerDatabase;

    yield* db.insert(blocksTable).values({
      chainId: 1n,
      height: 100n,
      hash: "0x0000000000000000000000000000000000000000000000000000000000000001",
      indexBlockHash: "0x0000000000000000000000000000000000000000000000000000000000000002",
      blockTime: 1000n,
      tenureHeight: 1n,
    });
  });

  const runBatchInTransaction = (indexing: IndexingService) =>
    Effect.runPromiseExit(
      IndexerDatabase.transaction(() => indexing.executeBatch([createStoredEvent()])).pipe(
        Effect.provideService(IndexerDatabase, testDb.db),
        Effect.provideService(References.MinimumLogLevel, "None"),
      ),
    );

  test("commits handler writes together with the event", async () => {
    const indexing = createIndexing({
      contracts: [tokenContract(() => insertBlock)],
      client: makeStacksClient(),
    });

    expect(Exit.isSuccess(await runBatchInTransaction(indexing))).toBe(true);
    await expect(testDb.db.select().from(blocksTable)).resolves.toHaveLength(1);
  });

  test("rolls back handler writes when the handler fails", async () => {
    const error = new Error("Handler failed");

    const indexing = createIndexing({
      contracts: [tokenContract(() => insertBlock.pipe(Effect.andThen(Effect.fail(error))))],
      client: makeStacksClient(),
    });

    const result = await runBatchInTransaction(indexing);

    expect(result).toBeTaggedError(
      new HandlerExecutionError({ contract: "token", contractId: CONTRACT_ID, cause: error }),
    );
    await expect(testDb.db.select().from(blocksTable)).resolves.toHaveLength(0);
  });
});
