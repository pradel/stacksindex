// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-return
// oxlint-disable typescript/no-explicit-any
// oxlint-disable jest/no-conditional-in-test
// oxlint-disable vitest/prefer-called-once
import { URL } from "node:url";

import { sql } from "drizzle-orm";
import { Deferred, Effect, Exit, Fiber, Match, Predicate, References, type Schema } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import {
  FilterValidationError,
  HandlerExecutionError,
  InvalidCursorError,
  SyncStoreError,
  TransactionBatchError,
} from "../lib/errors.ts";
import type { HandlerContext, HandlerEvent } from "../lib/types.ts";
import { createHistoricalRuntime } from "../promise/index.ts";
import { toThenable } from "../promise/thenable.ts";
import { syncStore } from "../sync-store/index.ts";
import {
  blocksTable,
  checkpointsTable,
  eventsTable,
  transactionsTable,
} from "../sync-store/schema.ts";
import { parseLogsCursor, parseTransactionCursor } from "../sync/cursor.ts";
import { expectStatusError } from "../test-utils/http-errors.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { HistoricalRuntime, type Filter, type HistoricalRuntimeOptions } from "./historical.ts";

const makeRuntime = (input: { db: IndexerDb } & HistoricalRuntimeOptions) => {
  const layer = HistoricalRuntime.layer({
    network: input.network,
    api: input.api,
    finality: input.finality,
  });

  return {
    run: (filters: Filter[]) =>
      toThenable(
        Effect.gen(function* () {
          const runtime = yield* HistoricalRuntime;

          return yield* runtime.run(filters);
        }).pipe(
          Effect.provide(layer),
          Effect.provideService(IndexerDatabase, input.db),
          Effect.provideService(References.MinimumLogLevel, "None"),
        ),
      ),
  };
};

interface Dictionary<TValue> {
  [key: string]: TValue;
}

type FetchInput = string | URL;

const mockRequest = vi.hoisted(() => vi.fn());

const toUrlString = (url: FetchInput): string => (Predicate.isString(url) ? url : url.href);

const mockFetch = vi.fn(async (rawUrl: FetchInput, init?: any) => {
  const url = toUrlString(rawUrl);
  let headersObj: Dictionary<string> = {};

  if (init?.headers) {
    if (Predicate.isFunction(init.headers.entries)) {
      headersObj = Object.fromEntries(init.headers.entries());
    } else if (Predicate.isObject(init.headers)) {
      headersObj = { ...init.headers };
    }
  }

  const requestInit = { ...init, headers: headersObj };
  let res: any;

  try {
    res = await mockRequest(url, requestInit);
  } catch (err: any) {
    if (url.includes("/extended/v1/tx/")) {
      const txId = url.split("/").pop()?.split("?")[0] ?? "tx-1";

      return new Response(
        JSON.stringify({
          tx_id: txId,
          block_height: 100,
          tx_index: 0,
          microblock_sequence: 0,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    throw err;
  }

  if (!res) {
    throw new Error(`mockRequest returned undefined for ${url}`);
  }

  if (res instanceof Response) {
    return res;
  }

  const status = res.statusCode ?? 200;

  const statusText =
    res.statusText ??
    Match.value(status).pipe(
      Match.when(200, () => "OK"),
      Match.when(404, () => "Not Found"),
      Match.orElse(() => String(status)),
    );

  const data = res.body?.json ? await res.body.json() : (res.body ?? res);

  return new Response(JSON.stringify(data), {
    status,
    statusText,
    headers: { "content-type": "application/json", ...res.headers },
  });
});

const noopHandler = () => Effect.void;

const mockBody = <T>(data: T) => ({
  json: () => Promise.resolve(data),
});

const parseBatchIds = (url: string): string[] => {
  const query = url.split("?")[1] ?? "";
  const ids: string[] = [];

  for (const part of query.split("&")) {
    const [key, ...rest] = part.split("=");

    if (key === "tx_id") {
      const value = rest.join("=");

      for (const id of value.split(",")) {
        if (id !== "") {
          ids.push(id);
        }
      }
    }
  }

  return ids;
};

const standardTx = (txId: string, height: number, hash: string, txIndex = 0) => ({
  tx_id: txId,
  event_count: 1,
  type: "contract_call",
  status: "success",
  fee_rate: "1000",
  sender: { address: "SP sender", nonce: 0 },
  sponsor: null,
  block: { hash, height, time: 1000, tx_index: txIndex },
  bitcoin_block: { height, time: 1000 },
});

const standardTxById: Dictionary<Schema.Json> = {
  "tx-1": standardTx("tx-1", 100, "block-1"),
  "tx-2": standardTx("tx-2", 200, "block-2"),
  "tx-100": standardTx("tx-100", 100, "block-100"),
  "tx-150": standardTx("tx-150", 150, "block-150"),
  "tx-200": standardTx("tx-200", 200, "block-200"),
  "tx-100-1": standardTx("tx-100-1", 100, "block-100", 10),
  "tx-100-2": standardTx("tx-100-2", 100, "block-100", 20),
  "tx-100-3": standardTx("tx-100-3", 100, "block-100", 30),
  "tx-150-1": standardTx("tx-150-1", 150, "block-150", 50),
};

const handledEventBlockHeight = (event: HandlerEvent) =>
  BigInt(100_000 + event.event_index + (event.block_height === 200 ? 10_000 : 0));

const handledEventBlock = (event: HandlerEvent, context: HandlerContext) =>
  context.db
    .insert(blocksTable)
    .values({
      chainId: 1n,
      height: handledEventBlockHeight(event),
      hash: `handled-${event.block_height}-${event.event_index}`,
      blockTime: 0n,
      tenureHeight: 0n,
    })
    .pipe(Effect.asVoid);

const failOnBlock200 = (event: HandlerEvent, context: HandlerContext) =>
  event.block_height === 200
    ? Effect.fail(new Error("Handler failed"))
    : handledEventBlock(event, context);

const blockOnBlock200Handler =
  (started: Deferred.Deferred<"started">) => (event: HandlerEvent, context: HandlerContext) => {
    if (event.block_height === 200) {
      return Deferred.succeed(started, "started").pipe(Effect.andThen(Effect.never));
    }

    return handledEventBlock(event, context);
  };

const storedEventRow = (txId: string, blockHeight: number, eventIndex: number) => ({
  chainId: 1n,
  contractId: "SP123.token",
  txId,
  eventIndex,
  eventType: "smart_contract_log",
  topic: "print",
  valueHex: "0x01",
  valueRepr: "(ok true)",
  blockHeight: BigInt(blockHeight),
});

/** Seeds blocks, transactions, events and a completed sync_progress row. */
const seedCompleteContract = async (
  testDb: TestDatabase,
  contractId: string,
  blockHeights: number[],
) => {
  await testDb.db.insert(blocksTable).values(
    blockHeights.map((height) => ({
      chainId: 1n,
      height: BigInt(height),
      hash: `block-${height}`,
      blockTime: BigInt(height * 10),
      tenureHeight: BigInt(height),
    })),
  );
  await testDb.db.insert(transactionsTable).values(
    blockHeights.map((height) => ({
      chainId: 1n,
      txId: `tx-${height}`,
      blockHeight: BigInt(height),
      blockHash: `block-${height}`,
      txIndex: 0,
      txType: "contract_call",
      senderAddress: "SP sender",
      feeRate: 1000n,
      nonce: 0n,
      txStatus: "success",
    })),
  );
  await testDb.db
    .insert(eventsTable)
    .values(blockHeights.map((height) => storedEventRow(`tx-${height}`, height, 0)));
  await testDb.run(
    syncStore.upsertSyncProgress({
      contractId,
      chainId: 1,
      cursor: null,
      lastBlockHeight: Math.max(...blockHeights),
      isComplete: true,
    }),
  );
};

describe("historical runtime", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    vi.stubGlobal("fetch", mockFetch);
    await testDb.cleanup();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await testDb.close();
  });

  test("fetches and stores blocks and transactions for a single contract", async () => {
    const contractId = "SP123.token";

    const txById: Dictionary<Schema.Json> = {
      "tx-1": {
        tx_id: "tx-1",
        event_count: 1,
        type: "contract_call",
        status: "success",
        fee_rate: "1000",
        sender: { address: "SP sender", nonce: 0 },
        sponsor: null,
        block: { hash: "block-1", height: 100, time: 1000, tx_index: 0 },
        bitcoin_block: { height: 100, time: 1000 },
      },
      "tx-2": {
        tx_id: "tx-2",
        event_count: 1,
        type: "contract_call",
        status: "success",
        fee_rate: "1000",
        sender: { address: "SP sender", nonce: 0 },
        sponsor: null,
        block: { hash: "block-2", height: 200, time: 2000, tx_index: 0 },
        bitcoin_block: { height: 200, time: 2000 },
      },
    };

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => txById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-1",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 2,
            next_cursor: "200:0:0:0",
            prev_cursor: null,
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=200:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-2",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 2,
            next_cursor: null,
            prev_cursor: "100:0:0:0",
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-2")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-2",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-2",
              height: 200,
              time: 2000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 200,
              time: 2000,
            },
            events: [],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-1",
            block_time: 1,
            block_time_iso: "",
            tenure_height: 1,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 1,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-2")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 200,
            hash: "block-2",
            block_time: 2,
            block_time_iso: "",
            tenure_height: 2,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 2,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 2,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result).toBeDefined();

    // Verify blocks stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((row) => Number(row.height))).toContain(100);
    expect(blocks.map((row) => Number(row.height))).toContain(200);

    // Verify transactions stored
    const transactions = await testDb.db.select().from(transactionsTable);
    expect(transactions).toHaveLength(2);

    // Verify sync progress
    const progress = await testDb.run(syncStore.getSyncProgress({ contractId, chainId: 1 }));

    if (progress === null) {
      throw new Error("Expected progress to be defined");
    }

    expect(progress.cursor).toBeNull();
    expect(progress.isComplete).toBe(false);
    expect(Number(progress.lastBlockHeight)).toBe(200);
  });

  test("schedules multiple contracts fairly by block height", async () => {
    const contractA = "SP123.token-a";
    const contractB = "SP456.token-b";

    const makeTxData = ({
      txId,
      blockHeight,
      blockHash,
      contractId,
    }: {
      txId: string;
      blockHeight: number;
      blockHash: string;
      contractId: string;
    }) => ({
      tx_id: txId,
      event_count: 1,
      type: "contract_call",
      status: "success",
      fee_rate: "1000",
      sender: { address: "SP sender", nonce: 0 },
      sponsor: null,
      block: {
        hash: blockHash,
        height: blockHeight,
        time: blockHeight * 10,
        tx_index: 0,
      },
      bitcoin_block: {
        height: blockHeight,
        time: blockHeight * 10,
      },
      events: [
        {
          event_index: 0,
          event_type: "smart_contract_log",
          contract_log: { contract_id: contractId, topic: "print", value: { hex: "", repr: "" } },
        },
      ],
    });

    const txMap: Dictionary<ReturnType<typeof makeTxData>> = {
      "tx-a-init": makeTxData({
        txId: "tx-a-init",
        blockHeight: 100,
        blockHash: "block-a-init",
        contractId: contractA,
      }),
      "tx-b-init": makeTxData({
        txId: "tx-b-init",
        blockHeight: 50,
        blockHash: "block-b-init",
        contractId: contractB,
      }),
      "tx-a-1": makeTxData({
        txId: "tx-a-1",
        blockHeight: 100,
        blockHash: "block-a-1",
        contractId: contractA,
      }),
      "tx-b-1": makeTxData({
        txId: "tx-b-1",
        blockHeight: 50,
        blockHash: "block-b-1",
        contractId: contractB,
      }),
      "tx-a-2": makeTxData({
        txId: "tx-a-2",
        blockHeight: 200,
        blockHash: "block-a-2",
        contractId: contractA,
      }),
      "tx-b-2": makeTxData({
        txId: "tx-b-2",
        blockHeight: 150,
        blockHash: "block-b-2",
        contractId: contractB,
      }),
    };

    const makeBlockResponse = (height: number, hash: string) => ({
      statusCode: 200,
      body: mockBody({
        height,
        hash,
        block_time: height,
        block_time_iso: "",
        tenure_height: height,
        index_block_hash: "",
        parent_block_hash: "",
        parent_index_block_hash: "",
        burn_block_time: height,
        burn_block_time_iso: "",
        burn_block_hash: "",
        burn_block_height: height,
        miner_txid: "",
        tx_count: 1,
        execution_cost_read_count: 0,
        execution_cost_read_length: 0,
        execution_cost_runtime: 0,
        execution_cost_write_count: 0,
        execution_cost_write_length: 0,
      }),
    });

    const makeLogsResponse = (results: any[], nextCursor: string | null) => ({
      statusCode: 200,
      body: mockBody({
        results,
        limit: 100,
        offset: 0,
        total: results.length,
        next_cursor: nextCursor,
        prev_cursor: null,
      }),
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      // Contract A initialization
      if (url.includes(`/extended/v3/smart-contracts/${contractA}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractA,
            block: { height: 100 },
            tx_id: "tx-a-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractA}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-a-init", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      // Contract B initialization
      if (url.includes(`/extended/v3/smart-contracts/${contractB}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractB,
            block: { height: 50 },
            tx_id: "tx-b-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractB}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-b-init", block: { height: 50, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => txMap[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      for (const [txId, txData] of Object.entries(txMap)) {
        if (url.includes(`/extended/v3/transactions/${txId}/events`)) {
          const { events } = txData;

          return {
            statusCode: 200,
            body: mockBody({
              total: events.length,
              limit: 50,
              cursor: { next: null, previous: null, current: "0" },
              results: events.map((event) => {
                const mappedEvent = {
                  event_index: event.event_index,
                  type:
                    event.event_type === "smart_contract_log" ? "contract_log" : event.event_type,
                };

                if (event.event_type !== "smart_contract_log") {
                  return mappedEvent;
                }

                return { ...mappedEvent, contract_log: event.contract_log };
              }),
            }),
          };
        }

        if (url.includes(`/extended/v3/transactions/${txId}`)) {
          return { statusCode: 200, body: mockBody(txData) };
        }
      }

      // Contract A page 1 (cursor 100)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractA}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return makeLogsResponse(
          [
            {
              tx_id: "tx-a-1",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_log: {
                contract_id: contractA,
                topic: "print",
                value: { hex: "", repr: "" },
              },
            },
          ],
          "200:0:0:0",
        );
      }

      if (url.includes("/extended/v2/blocks/block-a-1")) {
        return makeBlockResponse(100, "block-a-1");
      }

      // Contract B page 1 (cursor 50)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractB}/logs?limit=100&cursor=50:0:0:0`)
      ) {
        return makeLogsResponse(
          [
            {
              tx_id: "tx-b-1",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_log: {
                contract_id: contractB,
                topic: "print",
                value: { hex: "", repr: "" },
              },
            },
          ],
          "150:0:0:0",
        );
      }

      if (url.includes("/extended/v2/blocks/block-b-1")) {
        return makeBlockResponse(50, "block-b-1");
      }

      // Contract A page 2 (cursor 200)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractA}/logs?limit=100&cursor=200:0:0:0`)
      ) {
        return makeLogsResponse(
          [
            {
              tx_id: "tx-a-2",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_log: {
                contract_id: contractA,
                topic: "print",
                value: { hex: "", repr: "" },
              },
            },
          ],
          null,
        );
      }

      if (url.includes("/extended/v2/blocks/block-a-2")) {
        return makeBlockResponse(200, "block-a-2");
      }

      // Contract B page 2 (cursor 150)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractB}/logs?limit=100&cursor=150:0:0:0`)
      ) {
        return makeLogsResponse(
          [
            {
              tx_id: "tx-b-2",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_log: {
                contract_id: contractB,
                topic: "print",
                value: { hex: "", repr: "" },
              },
            },
          ],
          null,
        );
      }

      if (url.includes("/extended/v2/blocks/block-b-2")) {
        return makeBlockResponse(150, "block-b-2");
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });

    const result = await runtime.run([
      { contractId: contractA, handler: noopHandler },
      { contractId: contractB, handler: noopHandler },
    ]);

    expect(result).toBeDefined();

    // Verify fair scheduling by checking the order of getContractLogs calls
    const logsCalls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("/logs?limit=100&cursor="),
    );

    expect(logsCalls).toHaveLength(4);

    // B starts at 50, A at 100 -> B should go first
    expect(decodeURIComponent(String(logsCalls[0][0]))).toContain("cursor=50:0:0:0");
    expect(logsCalls[0][0]).toContain(contractB);

    // After B advances to 150, A is at 100 -> A should go next
    expect(decodeURIComponent(String(logsCalls[1][0]))).toContain("cursor=100:0:0:0");
    expect(logsCalls[1][0]).toContain(contractA);

    // A advances to 200, B is at 150 -> B should go next
    expect(decodeURIComponent(String(logsCalls[2][0]))).toContain("cursor=150:0:0:0");
    expect(logsCalls[2][0]).toContain(contractB);

    // Finally A at 200
    expect(decodeURIComponent(String(logsCalls[3][0]))).toContain("cursor=200:0:0:0");
    expect(logsCalls[3][0]).toContain(contractA);
  });

  test("resumes from saved cursor without refetching first cursor", async () => {
    const contractId = "SP123.token";

    // Pre-seed sync progress
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
      }),
    );

    const txByIdResume: Dictionary<Schema.Json> = {
      "tx-1": {
        tx_id: "tx-1",
        type: "contract_call",
        status: "success",
        fee_rate: "1000",
        sender: { address: "SP sender", nonce: 0 },
        sponsor: null,
        block: { hash: "block-1", height: 100, time: 1000, tx_index: 0 },
        bitcoin_block: { height: 100, time: 1000 },
      },
    };

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => txByIdResume[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-1",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-1",
            block_time: 1,
            block_time_iso: "",
            tenure_height: 1,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 1,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result).toBeDefined();

    // Should not have called getPrincipalTransactions (first cursor discovery)
    const addressTxCalls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("/principals/"),
    );

    expect(addressTxCalls).toHaveLength(0);

    // Blocks and transactions should be stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(1);
  });

  test("skips API calls for transactions and blocks already in database", async () => {
    const contractId = "SP123.token";

    // Pre-seed sync progress, transaction, and block
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
      }),
    );
    await testDb.db.insert(transactionsTable).values({
      chainId: 1n,
      txId: "tx-1",
      blockHeight: 100n,
      blockHash: "block-1",
      txIndex: 0,
      txType: "contract_call",
      senderAddress: "SP sender",
      feeRate: 1000n,
      nonce: 0n,
      txStatus: "success",
    });
    await testDb.db.insert(blocksTable).values({
      chainId: 1n,
      height: 100n,
      hash: "block-1",
      blockTime: 1n,
      tenureHeight: 1n,
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      // If we reach here, an unexpected API call was made
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result).toBeDefined();

    // Verify no getTransaction or getBlock calls were made
    const txCalls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("/extended/v3/transactions/"),
    );

    const blockCalls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("/extended/v2/blocks/"),
    );

    expect(txCalls).toHaveLength(0);
    expect(blockCalls).toHaveLength(0);
  });

  test("returns error when getContractLogs fails", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-1",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 400,
          statusText: "Bad Request",
          body: mockBody({ error: "Logs API error" }),
          headers: { "content-type": "application/json" },
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await Effect.runPromiseExit(runtime.run([{ contractId, handler: noopHandler }]));

    await expectStatusError(result, {
      status: 400,
      path: `/extended/v2/smart-contracts/${contractId}/logs`,
      body: { error: "Logs API error" },
    });
  });

  test("completes immediately when contract has no events", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 0,
            cursor: { next: null, previous: null, current: "" },
            results: [],
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result).toBeDefined();

    // Nothing should be stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(0);
  });

  test("skips non-smart_contract_log events without crashing", async () => {
    const contractId = "SP123.token";

    const txByIdNonLog: Dictionary<Schema.Json> = {
      "tx-1": {
        tx_id: "tx-1",
        event_count: 2,
        type: "contract_call",
        status: "success",
        fee_rate: "1000",
        sender: { address: "SP sender", nonce: 0 },
        sponsor: null,
        block: { hash: "block-1", height: 100, time: 1000, tx_index: 0 },
        bitcoin_block: { height: 100, time: 1000 },
      },
    };

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => txByIdNonLog[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 2,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "stx_asset",
              },
              {
                event_index: 1,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "0x01", repr: "123" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 2,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-1",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "stx_asset",
              },
              {
                event_index: 1,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "0x01", repr: "123" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:1`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "stx_asset",
                contract_id: contractId,
                topic: "stx",
                // No `value` property here
              },
              {
                tx_id: "tx-1",
                event_index: 1,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "0x01", repr: "123" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 2,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-1",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result).toBeDefined();

    const storedEvents = await testDb.db.select().from(eventsTable);
    expect(storedEvents).toHaveLength(1);
    expect(storedEvents[0]).toMatchObject({
      eventType: "smart_contract_log",
      txId: "tx-1",
      eventIndex: 1,
      valueHex: "0x01",
      valueRepr: "123",
    });
  });
});

describe("cursor parser helpers", () => {
  test("parses valid logs cursor", async () => {
    const result = await Effect.runPromise(parseLogsCursor("100:0:5:2"));
    expect(result).toStrictEqual({
      blockHeight: 100,
      microblockSequence: 0,
      txIndex: 5,
      eventIndex: 2,
    });
  });

  test("fails on invalid logs cursor format", async () => {
    for (const cursor of ["invalid", "100:0:5:2:1", "100:0:5"]) {
      const error = await Effect.runPromise(parseLogsCursor(cursor).pipe(Effect.flip));

      expect(error).toBeInstanceOf(InvalidCursorError);
      expect(error.format).toBe("logs");
      expect(error.cursor).toBe(cursor);
    }
  });

  test("parses valid transaction cursor", async () => {
    const result = await Effect.runPromise(parseTransactionCursor("100:0:5"));
    expect(result).toStrictEqual({
      blockHeight: 100,
      microblockSequence: 0,
      txIndex: 5,
    });
  });

  test("fails on invalid transaction cursor format", async () => {
    for (const cursor of ["invalid", "100:0:5:2"]) {
      const error = await Effect.runPromise(parseTransactionCursor(cursor).pipe(Effect.flip));

      expect(error).toBeInstanceOf(InvalidCursorError);
      expect(error.format).toBe("transaction");
      expect(error.cursor).toBe(cursor);
    }
  });
});

describe("historical runtime with handlers", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    await testDb.cleanup();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await testDb.close();
  });

  test("calls handlers in global chronological order across contracts", async () => {
    const contractA = "SP123.token-a";
    const contractB = "SP456.token-b";
    const handlerA = vi.fn().mockReturnValue(Effect.void);
    const handlerB = vi.fn().mockReturnValue(Effect.void);

    const makeTxData = ({
      txId,
      blockHeight,
      blockHash,
      contractId,
    }: {
      txId: string;
      blockHeight: number;
      blockHash: string;
      contractId: string;
    }) => ({
      tx_id: txId,
      event_count: 1,
      type: "contract_call",
      status: "success",
      fee_rate: "1000",
      sender: { address: "SP sender", nonce: 0 },
      sponsor: null,
      block: {
        hash: blockHash,
        height: blockHeight,
        time: blockHeight * 10,
        tx_index: 0,
      },
      bitcoin_block: {
        height: blockHeight,
        time: blockHeight * 10,
      },
      events: [
        {
          event_index: 0,
          event_type: "smart_contract_log",
          contract_log: { contract_id: contractId, topic: "print", value: { hex: "", repr: "" } },
        },
      ],
    });

    const txMap: Dictionary<ReturnType<typeof makeTxData>> = {
      "tx-a-init": makeTxData({
        txId: "tx-a-init",
        blockHeight: 100,
        blockHash: "block-a-init",
        contractId: contractA,
      }),
      "tx-b-init": makeTxData({
        txId: "tx-b-init",
        blockHeight: 50,
        blockHash: "block-b-init",
        contractId: contractB,
      }),
      "tx-a-1": makeTxData({
        txId: "tx-a-1",
        blockHeight: 100,
        blockHash: "block-a-1",
        contractId: contractA,
      }),
      "tx-b-1": makeTxData({
        txId: "tx-b-1",
        blockHeight: 50,
        blockHash: "block-b-1",
        contractId: contractB,
      }),
    };

    const makeBlockResponse = (height: number, hash: string) => ({
      statusCode: 200,
      body: mockBody({
        height,
        hash,
        block_time: height,
        block_time_iso: "",
        tenure_height: height,
        index_block_hash: "",
        parent_block_hash: "",
        parent_index_block_hash: "",
        burn_block_time: height,
        burn_block_time_iso: "",
        burn_block_hash: "",
        burn_block_height: height,
        miner_txid: "",
        tx_count: 1,
        execution_cost_read_count: 0,
        execution_cost_read_length: 0,
        execution_cost_runtime: 0,
        execution_cost_write_count: 0,
        execution_cost_write_length: 0,
      }),
    });

    const makeLogsResponse = (results: any[], nextCursor: string | null) => ({
      statusCode: 200,
      body: mockBody({
        results,
        limit: 100,
        offset: 0,
        total: results.length,
        next_cursor: nextCursor,
        prev_cursor: null,
      }),
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      // Contract A initialization
      if (url.includes(`/extended/v3/smart-contracts/${contractA}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractA,
            block: { height: 100 },
            tx_id: "tx-a-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractA}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-a-init", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      // Contract B initialization
      if (url.includes(`/extended/v3/smart-contracts/${contractB}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractB,
            block: { height: 50 },
            tx_id: "tx-b-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractB}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-b-init", block: { height: 50, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => txMap[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      for (const [txId, txData] of Object.entries(txMap)) {
        if (url.includes(`/extended/v3/transactions/${txId}/events`)) {
          const { events } = txData;

          return {
            statusCode: 200,
            body: mockBody({
              total: events.length,
              limit: 50,
              cursor: { next: null, previous: null, current: "0" },
              results: events.map((event) => {
                const mappedEvent = {
                  event_index: event.event_index,
                  type:
                    event.event_type === "smart_contract_log" ? "contract_log" : event.event_type,
                };

                if (event.event_type !== "smart_contract_log") {
                  return mappedEvent;
                }

                return { ...mappedEvent, contract_log: event.contract_log };
              }),
            }),
          };
        }

        if (url.includes(`/extended/v3/transactions/${txId}`)) {
          return { statusCode: 200, body: mockBody(txData) };
        }
      }

      // Contract A page 1 (cursor 100)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractA}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return makeLogsResponse(
          [
            {
              tx_id: "tx-a-1",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_log: {
                contract_id: contractA,
                topic: "print",
                value: { hex: "", repr: "" },
              },
            },
          ],
          null,
        );
      }

      if (url.includes("/extended/v2/blocks/block-a-1")) {
        return makeBlockResponse(100, "block-a-1");
      }

      // Contract B page 1 (cursor 50)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractB}/logs?limit=100&cursor=50:0:0:0`)
      ) {
        return makeLogsResponse(
          [
            {
              tx_id: "tx-b-1",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_log: {
                contract_id: contractB,
                topic: "print",
                value: { hex: "", repr: "" },
              },
            },
          ],
          null,
        );
      }

      if (url.includes("/extended/v2/blocks/block-b-1")) {
        return makeBlockResponse(50, "block-b-1");
      }

      if (url.includes("/extended/v2/blocks/block-a-init")) {
        return makeBlockResponse(100, "block-a-init");
      }

      if (url.includes("/extended/v2/blocks/block-b-init")) {
        return makeBlockResponse(50, "block-b-init");
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
    });

    const result = await runtime.run([
      { contractId: contractA, handler: handlerA },
      { contractId: contractB, handler: handlerB },
    ]);

    expect(result).toBeDefined();

    // Both handlers should be called
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);

    // B's event is at block 50, A's at block 100
    // B should be called first because its block is lower
    expect(handlerB).toHaveBeenCalledBefore(handlerA);

    // Verify the events have correct block heights
    expect(handlerB.mock.calls[0][0].block_height).toBe(50);
    expect(handlerA.mock.calls[0][0].block_height).toBe(100);
  });

  test("updates checkpoint after processing events", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockReturnValue(Effect.void);

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-1",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-1",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
    });

    const result = await runtime.run([{ contractId, handler }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);

    // Verify checkpoint was updated
    const checkpoint = await testDb.db.select().from(checkpointsTable);
    expect(checkpoint).toHaveLength(1);
    expect(Number(checkpoint[0].blockHeight)).toBe(100);
    expect(Number(checkpoint[0].blockTime)).toBe(1000);
  });

  test("does not re-process events below checkpoint on restart", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockReturnValue(Effect.void);

    // Pre-seed checkpoint so block 100 is already processed
    await testDb.run(
      syncStore.upsertCheckpoint({
        chainId: 1,
        blockHeight: 100,
        blockTime: 1000,
        finalizedBlockHeight: 100,
        finalizedBlockTime: 1000,
      }),
    );
    // Pre-seed sync progress so it skips first cursor discovery
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
      }),
    );
    // Pre-seed block, transaction, and event
    await testDb.db.insert(blocksTable).values({
      chainId: 1n,
      height: 100n,
      hash: "block-1",
      blockTime: 1000n,
      tenureHeight: 100n,
    });
    await testDb.db.insert(transactionsTable).values({
      chainId: 1n,
      txId: "tx-1",
      blockHeight: 100n,
      blockHash: "block-1",
      txIndex: 0,
      txType: "contract_call",
      senderAddress: "SP sender",
      feeRate: 1000n,
      nonce: 0n,
      txStatus: "success",
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
    });

    const result = await runtime.run([{ contractId, handler }]);

    expect(result).toBeDefined();
    // Handler should NOT be called because the event is at block 100 which is already checkpointed
    expect(handler).not.toHaveBeenCalled();
  });

  test("commits block-aligned batches and resumes from the last committed batch", async () => {
    const contractId = "SP123.token";

    // Block 100 holds 1000 events (the maximum batch size) and block 200 holds
    // 500, so indexing splits into one batch per block.
    await testDb.db.insert(blocksTable).values([
      { chainId: 1n, height: 100n, hash: "block-100", blockTime: 1000n, tenureHeight: 100n },
      { chainId: 1n, height: 200n, hash: "block-200", blockTime: 2000n, tenureHeight: 200n },
    ]);
    await testDb.db.insert(transactionsTable).values([
      {
        chainId: 1n,
        txId: "tx-100",
        blockHeight: 100n,
        blockHash: "block-100",
        txIndex: 0,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
      },
      {
        chainId: 1n,
        txId: "tx-200",
        blockHeight: 200n,
        blockHash: "block-200",
        txIndex: 0,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
      },
    ]);
    await testDb.db
      .insert(eventsTable)
      .values([
        ...Array.from({ length: 1000 }, (_, eventIndex) =>
          storedEventRow("tx-100", 100, eventIndex),
        ),
        ...Array.from({ length: 500 }, (_, eventIndex) =>
          storedEventRow("tx-200", 200, eventIndex),
        ),
      ]);

    // Mark the contract complete so the run makes no Stacks API requests.
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 200,
        isComplete: true,
      }),
    );

    const runtime = makeRuntime({ db: testDb.db });
    const failingHandler = vi.fn(failOnBlock200);

    const failure = await Effect.runPromiseExit(
      runtime.run([{ contractId, handler: failingHandler, endBlock: 200 }]),
    );

    expect(failure).toBeTaggedError(
      new HandlerExecutionError({ contractId, cause: new Error("Handler failed") }),
    );
    // 1000 events from block 100 plus the first event of block 200.
    expect(failingHandler).toHaveBeenCalledTimes(1001);

    const handledAfterFailure = (await testDb.db.select().from(blocksTable)).filter(
      (row) => Number(row.height) >= 100_000,
    );

    expect(handledAfterFailure).toHaveLength(1000);
    const checkpointAfterFailure = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpointAfterFailure[0].blockHeight)).toBe(100);

    const succeedingHandler = vi.fn(handledEventBlock);
    const result = await runtime.run([{ contractId, handler: succeedingHandler, endBlock: 200 }]);

    expect(result.eventsProcessed).toBe(500);
    expect(succeedingHandler).toHaveBeenCalledTimes(500);

    const handledAfterResume = (await testDb.db.select().from(blocksTable)).filter(
      (row) => Number(row.height) >= 100_000,
    );

    expect(handledAfterResume).toHaveLength(1500);
    const checkpointAfterResume = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpointAfterResume[0].blockHeight)).toBe(200);
  });

  test("finalizes the indexed height by default", async () => {
    const contractId = "SP123.token";
    await seedCompleteContract(testDb, contractId, [100]);

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler, endBlock: 100 }]);

    expect(result.finalizedBlockHeight).toBe(100);

    const checkpoint = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpoint[0].blockHeight)).toBe(100);
    expect(Number(checkpoint[0].finalizedBlockHeight)).toBe(100);
    expect(Number(checkpoint[0].finalizedBlockTime)).toBe(1000);
  });

  test("keeps the trailing finality window unfinalized", async () => {
    const contractId = "SP123.token";
    await seedCompleteContract(testDb, contractId, [100, 200, 300]);

    const runtime = makeRuntime({ db: testDb.db, finality: 50 });
    const result = await runtime.run([{ contractId, handler: noopHandler, endBlock: 300 }]);

    expect(result.finalizedBlockHeight).toBe(200);

    const checkpoint = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpoint[0].blockHeight)).toBe(300);
    expect(Number(checkpoint[0].finalizedBlockHeight)).toBe(200);
    expect(Number(checkpoint[0].finalizedBlockTime)).toBe(2000);
  });

  test("leaves nothing finalized when finality exceeds the indexed range", async () => {
    const contractId = "SP123.token";
    await seedCompleteContract(testDb, contractId, [100]);

    const runtime = makeRuntime({ db: testDb.db, finality: 500 });
    const result = await runtime.run([{ contractId, handler: noopHandler, endBlock: 100 }]);

    expect(result.finalizedBlockHeight).toBe(0);

    const checkpoint = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpoint[0].blockHeight)).toBe(100);
    expect(Number(checkpoint[0].finalizedBlockHeight)).toBe(0);
  });

  test("finalizes the prior checkpoint across separate safe heights", async () => {
    const contractId = "SP123.token";

    const txById: Dictionary<Schema.Json> = {
      "tx-100": standardTx("tx-100", 100, "block-100"),
      "tx-200": standardTx("tx-200", 200, "block-200"),
      "tx-300": standardTx("tx-300", 300, "block-300"),
      "tx-400": standardTx("tx-400", 400, "block-400"),
    };

    const logsPage = (txId: string, nextCursor: string | null) => ({
      results: [
        {
          tx_id: txId,
          event_index: 0,
          event_type: "smart_contract_log",
          contract_log: {
            contract_id: contractId,
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

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => txById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes("cursor=100:0:0:0")) {
        return { statusCode: 200, body: mockBody(logsPage("tx-100", "200:0:0:0")) };
      }

      if (url.includes("cursor=200:0:0:0")) {
        return { statusCode: 200, body: mockBody(logsPage("tx-200", "300:0:0:0")) };
      }

      if (url.includes("cursor=300:0:0:0")) {
        return { statusCode: 200, body: mockBody(logsPage("tx-300", "400:0:0:0")) };
      }

      if (url.includes("cursor=400:0:0:0")) {
        return { statusCode: 200, body: mockBody(logsPage("tx-400", null)) };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    // Safe heights 199 and 299 index blocks 100 and 200. With a 150-block
    // Finality window the checkpoint is written with no finalized marker, then
    // The prior checkpoint becomes final once the safe height advances past it.
    const runtime = makeRuntime({ db: testDb.db, finality: 150 });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.finalizedBlockHeight).toBe(200);

    const checkpoint = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpoint[0].blockHeight)).toBe(400);
    expect(Number(checkpoint[0].finalizedBlockHeight)).toBe(200);
  });

  test("rejects invalid finality", async () => {
    const invalidFinalities = [-1, 1.5, Number.NaN];

    for (const finality of invalidFinalities) {
      const runtime = makeRuntime({ db: testDb.db, finality });

      const error = await Effect.runPromise(
        runtime.run([{ contractId: "SP123.token", handler: noopHandler }]).pipe(Effect.flip),
      );

      expect(Predicate.isTagged(error, "ConfigurationError")).toBe(true);
    }
  });

  test("discards unfinalized data on startup", async () => {
    const contractId = "SP123.token";

    await testDb.db.insert(blocksTable).values([
      { chainId: 1n, height: 100n, hash: "block-100", blockTime: 1000n, tenureHeight: 100n },
      { chainId: 1n, height: 300n, hash: "block-300", blockTime: 3000n, tenureHeight: 300n },
    ]);
    await testDb.db.insert(transactionsTable).values([
      {
        chainId: 1n,
        txId: "tx-100",
        blockHeight: 100n,
        blockHash: "block-100",
        txIndex: 0,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
      },
      {
        chainId: 1n,
        txId: "tx-300",
        blockHeight: 300n,
        blockHash: "block-300",
        txIndex: 0,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
      },
    ]);
    await testDb.db
      .insert(eventsTable)
      .values([storedEventRow("tx-100", 100, 0), storedEventRow("tx-300", 300, 0)]);

    // Block 300 is indexed but not finalized; block 200 is the finalized floor.
    await testDb.run(
      syncStore.upsertCheckpoint({
        chainId: 1,
        blockHeight: 300,
        blockTime: 3000,
        finalizedBlockHeight: 200,
        finalizedBlockTime: 2000,
      }),
    );
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 100,
        isComplete: true,
      }),
    );

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler, endBlock: 100 }]);

    expect(result.finalizedBlockHeight).toBe(200);

    const events = await testDb.db.select().from(eventsTable);
    expect(events.map((row) => Number(row.blockHeight))).toStrictEqual([100]);

    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks.map((row) => Number(row.height))).toStrictEqual([100]);

    const checkpoint = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpoint[0].blockHeight)).toBe(200);
    expect(Number(checkpoint[0].blockTime)).toBe(2000);
    expect(Number(checkpoint[0].finalizedBlockHeight)).toBe(200);
  });

  test("interrupting mid-batch keeps the last committed checkpoint", async () => {
    const contractId = "SP123.token";

    // Block 100 holds 1000 events and block 200 holds 1, so indexing runs as
    // Two batches: [block 100], then [block 200].
    await testDb.db.insert(blocksTable).values([
      { chainId: 1n, height: 100n, hash: "block-100", blockTime: 1000n, tenureHeight: 100n },
      { chainId: 1n, height: 200n, hash: "block-200", blockTime: 2000n, tenureHeight: 200n },
    ]);
    await testDb.db.insert(transactionsTable).values([
      {
        chainId: 1n,
        txId: "tx-100",
        blockHeight: 100n,
        blockHash: "block-100",
        txIndex: 0,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
      },
      {
        chainId: 1n,
        txId: "tx-200",
        blockHeight: 200n,
        blockHash: "block-200",
        txIndex: 0,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
      },
    ]);
    await testDb.db
      .insert(eventsTable)
      .values([
        ...Array.from({ length: 1000 }, (_, eventIndex) =>
          storedEventRow("tx-100", 100, eventIndex),
        ),
        storedEventRow("tx-200", 200, 0),
      ]);
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 200,
        isComplete: true,
      }),
    );

    const started = Effect.runSync(Deferred.make<"started">());
    const runtime = makeRuntime({ db: testDb.db });

    const fiber = Effect.runFork(
      runtime.run([{ contractId, handler: blockOnBlock200Handler(started), endBlock: 200 }]),
    );

    await Effect.runPromise(Deferred.await(started));
    await Effect.runPromise(Fiber.interrupt(fiber));

    // Batch [block 100] committed; the interrupted batch [block 200] rolled back.
    const checkpointAfterInterrupt = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpointAfterInterrupt[0].blockHeight)).toBe(100);

    const handledAfterInterrupt = (await testDb.db.select().from(blocksTable)).filter(
      (row) => Number(row.height) >= 100_000,
    );

    expect(handledAfterInterrupt).toHaveLength(1000);

    const result = await runtime.run([{ contractId, handler: handledEventBlock, endBlock: 200 }]);

    expect(result.finalizedBlockHeight).toBe(200);

    const handledAfterResume = (await testDb.db.select().from(blocksTable)).filter(
      (row) => Number(row.height) >= 100_000,
    );

    expect(handledAfterResume).toHaveLength(1001);

    const checkpointAfterResume = await testDb.db.select().from(checkpointsTable);
    expect(Number(checkpointAfterResume[0].blockHeight)).toBe(200);
  });

  test("returns error when handler throws", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockReturnValue(Effect.fail(new Error("Handler failed")));

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-1",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-1",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
    });

    const result = await Effect.runPromiseExit(runtime.run([{ contractId, handler }]));

    expect(result).toBeTaggedError(
      new HandlerExecutionError({
        contractId,
        cause: new Error("Handler failed"),
      }),
    );
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("uses custom baseUrl and apiKey when provided to runtime", async () => {
    const contractId = "SP123.token";
    const customBaseUrl = "https://custom-stacks.example.com";
    const customApiKey = "test-api-key-123";

    mockRequest.mockImplementation((rawUrl: string, init: { headers: Record<string, string> }) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      expect(new URL(url).origin).toBe(customBaseUrl);
      expect(init.headers["x-api-key"]).toBe(customApiKey);

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 0,
            cursor: { next: null, previous: null, current: "" },
            results: [],
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
      api: {
        baseUrl: customBaseUrl,
        apiKey: customApiKey,
      },
    });

    const result = await runtime.run([{ contractId, handler: noopHandler }]);
    expect(result).toBeDefined();
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  test("provides IndexingClient to handler with current block height tip and runtime api options", async () => {
    const contractId = "SP123.token";
    const customBaseUrl = "https://custom-stacks.example.com";
    const customApiKey = "test-api-key-123";

    let handlerCalled = false;
    let callReadOnlySuccess = false;
    // oxlint-disable-next-line init-declarations
    let callReadOnlyUrl: string | undefined;
    // oxlint-disable-next-line init-declarations
    let callReadOnlyApiKey: string | undefined;

    mockRequest.mockImplementation(
      (
        rawUrl: string,
        init?: { headers?: Record<string, string>; method?: string; body?: string },
      ) => {
        const url = decodeURIComponent(rawUrl);

        if (url.includes("/extended/v3/transactions/batch")) {
          const results = parseBatchIds(url)
            .map((id) =>
              id === "tx-1"
                ? {
                    tx_id: "tx-1",
                    event_count: 1,
                    type: "contract_call",
                    status: "success",
                    fee_rate: "1000",
                    sender: { address: "SP sender", nonce: 0 },
                    sponsor: null,
                    block: { hash: "block-1", height: 1234, time: 1000, tx_index: 0 },
                    bitcoin_block: { height: 1234, time: 1000 },
                  }
                : standardTxById[id],
            )
            .filter(Boolean);

          return { statusCode: 200, body: mockBody({ results }) };
        }

        if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
          return {
            statusCode: 200,
            body: mockBody({
              contract_id: contractId,
              block: { height: 1234 },
              tx_id: "tx-deploy",
            }),
          };
        }

        if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
          return {
            statusCode: 200,
            body: mockBody({
              limit: 50,
              total: 1,
              cursor: { next: null, previous: null, current: "curr" },
              results: [{ transaction: { tx_id: "tx-1", block: { height: 1234, tx_index: 0 } } }],
            }),
          };
        }

        if (url.includes("/extended/v3/transactions/tx-1/events")) {
          return {
            statusCode: 200,
            body: mockBody({
              total: 1,
              limit: 50,
              cursor: { next: null, previous: null, current: "0" },
              results: [
                {
                  event_index: 0,
                  type: "contract_log",
                  contract_log: {
                    contract_id: contractId,
                    topic: "print",
                    value: { hex: "", repr: "" },
                  },
                },
              ],
            }),
          };
        }

        if (url.includes("/extended/v3/transactions/tx-1")) {
          return {
            statusCode: 200,
            body: mockBody({
              tx_id: "tx-1",
              event_count: 1,
              type: "contract_call",
              status: "success",
              fee_rate: "1000",
              sender: { address: "SP sender", nonce: 0 },
              sponsor: null,
              block: {
                hash: "block-1",
                height: 1234,
                time: 1000,
                tx_index: 0,
              },
              events: [
                {
                  event_index: 0,
                  event_type: "smart_contract_log",
                  contract_log: {
                    contract_id: contractId,
                    topic: "print",
                    value: { hex: "", repr: "" },
                  },
                },
              ],
            }),
          };
        }

        if (
          url.includes(
            `/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=1234:0:0:0`,
          )
        ) {
          return {
            statusCode: 200,
            body: mockBody({
              results: [
                {
                  tx_id: "tx-1",
                  event_index: 0,
                  event_type: "smart_contract_log",
                  contract_log: {
                    contract_id: contractId,
                    topic: "print",
                    value: { hex: "", repr: "" },
                  },
                },
              ],
              limit: 100,
              offset: 0,
              total: 1,
              next_cursor: null,
              prev_cursor: null,
            }),
          };
        }

        if (url.includes("/extended/v2/blocks/block-1")) {
          return {
            statusCode: 200,
            body: mockBody({
              height: 1234,
              hash: "block-1",
              block_time: 1000,
              block_time_iso: "",
              tenure_height: 1234,
              index_block_hash: "",
              parent_block_hash: "",
              parent_index_block_hash: "",
              burn_block_time: 1000,
              burn_block_time_iso: "",
              burn_block_hash: "",
              burn_block_height: 1234,
              miner_txid: "",
              tx_count: 1,
              execution_cost_read_count: 0,
              execution_cost_read_length: 0,
              execution_cost_runtime: 0,
              execution_cost_write_count: 0,
              execution_cost_write_length: 0,
            }),
          };
        }

        if (url.includes("/v2/contracts/call-read/SP123/token/get-total-supply")) {
          callReadOnlyUrl = url;
          callReadOnlyApiKey = init?.headers?.["x-api-key"];

          return {
            statusCode: 200,
            body: mockBody({ okay: true, result: "0x01000000000000000000000000000003e8" }),
          };
        }

        throw new Error(`Unexpected URL: ${url}`);
      },
    );

    const runtime = makeRuntime({
      db: testDb.db,
      api: {
        baseUrl: customBaseUrl,
        apiKey: customApiKey,
      },
    });

    const result = await runtime.run([
      {
        contractId,
        handler: (_event, { client }) =>
          Effect.gen(function* () {
            handlerCalled = true;

            const readResult = yield* client.callReadOnly({
              contractId,
              functionName: "get-total-supply",
            });

            if (readResult === 1000n) {
              callReadOnlySuccess = true;
            }
          }),
      },
    ]);

    expect(result).toBeDefined();
    expect(handlerCalled).toBe(true);
    expect(callReadOnlySuccess).toBe(true);
    expect(callReadOnlyUrl).toBe(
      `${customBaseUrl}/v2/contracts/call-read/SP123/token/get-total-supply?tip=1234`,
    );
    expect(callReadOnlyApiKey).toBe(customApiKey);
  });

  test("creates a promise runtime, runs sync and cleans up on close", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 0,
            cursor: { next: null, previous: null, current: "" },
            results: [],
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = await createHistoricalRuntime({ database: { kind: "pglite" } });

    const result = await runtime.run({ contractId, handler: () => undefined });
    expect(result.contracts).toHaveLength(1);
    expect(result.contracts[0]?.contractId).toBe(contractId);

    await runtime.close();
  });

  test("filters events and starts synchronization at startBlock", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];

    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);

      return Effect.void;
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (
        url.includes(`/extended/v3/principals/${contractId}/transactions`) &&
        url.split("?")[1]?.split("&").includes("cursor=100:0:0")
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "100:0:0" },
            results: [{ transaction: { tx_id: "tx-100", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-100",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-100",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-100",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100 }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([100]);
  });

  test("filters events and bounds synchronization with startBlock and endBlock", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];

    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);

      return Effect.void;
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "100:0:0" },
            results: [{ transaction: { tx_id: "tx-100", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-100",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-100",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: "150:0:0:0",
            prev_cursor: null,
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=150:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-150",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: "100:0:0:0",
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-150")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-150",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-150",
              height: 150,
              time: 1500,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 150,
              time: 1500,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-100",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-150")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 150,
            hash: "block-150",
            block_time: 1500,
            block_time_iso: "",
            tenure_height: 150,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1500,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 150,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 150 }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handledHeights).toStrictEqual([100, 150]);
  });

  test("skips contract synchronization when initial event exceeds endBlock", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockReturnValue(Effect.void);

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "200:0:0" },
            results: [{ transaction: { tx_id: "tx-200", block: { height: 200, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-200/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-200")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-200",
            event_count: 1,
            block: {
              height: 200,
              tx_index: 0,
            },
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, endBlock: 100 }]);

    expect(result).toBeDefined();
    expect(handler).not.toHaveBeenCalled();
  });

  test("does not collect transactions or fetch blocks for transactions exceeding maxBlockHeight", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockReturnValue(Effect.void);

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "100:0:0" },
            results: [{ transaction: { tx_id: "tx-100", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
              {
                tx_id: "tx-200",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 2,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-100",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-100",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-200")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-200",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-200",
              height: 200,
              time: 2000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 200,
              time: 2000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-100",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-200")) {
        throw new Error("block-200 should not have been requested");
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 150 }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);

    // Block-200 should not have been fetched
    const block200Calls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("/extended/v2/blocks/block-200"),
    );

    expect(block200Calls).toHaveLength(0);
  });

  test("rejects invalid startBlock (negative or non-integer)", async () => {
    const contractId = "SP123.token";
    const runtime = makeRuntime({ db: testDb.db });

    const negativeResult = await Effect.runPromiseExit(
      runtime.run([{ contractId, handler: noopHandler, startBlock: -1 }]),
    );

    expect(negativeResult).toBeTaggedError(
      new FilterValidationError({
        message:
          'Validation failed: Expected a value greater than or equal to 0\n  at [0]["startBlock"]',
      }),
    );

    const floatResult = await Effect.runPromiseExit(
      runtime.run([{ contractId, handler: noopHandler, startBlock: 1.5 }]),
    );

    expect(floatResult).toBeTaggedError(
      new FilterValidationError({
        message: 'Validation failed: Expected an integer\n  at [0]["startBlock"]',
      }),
    );
  });

  test("rejects invalid endBlock (negative or non-integer)", async () => {
    const contractId = "SP123.token";
    const runtime = makeRuntime({ db: testDb.db });

    const negativeResult = await Effect.runPromiseExit(
      runtime.run([{ contractId, handler: noopHandler, endBlock: -5 }]),
    );

    expect(negativeResult).toBeTaggedError(
      new FilterValidationError({
        message:
          'Validation failed: Expected a value greater than or equal to 0\n  at [0]["endBlock"]',
      }),
    );

    const floatResult = await Effect.runPromiseExit(
      runtime.run([{ contractId, handler: noopHandler, endBlock: 100.2 }]),
    );

    expect(floatResult).toBeTaggedError(
      new FilterValidationError({
        message: 'Validation failed: Expected an integer\n  at [0]["endBlock"]',
      }),
    );
  });

  test("rejects when startBlock is greater than endBlock", async () => {
    const contractId = "SP123.token";
    const runtime = makeRuntime({ db: testDb.db });

    const result = await Effect.runPromiseExit(
      runtime.run([{ contractId, handler: noopHandler, startBlock: 200, endBlock: 100 }]),
    );

    expect(result).toBeTaggedError(
      new FilterValidationError({
        message:
          "Validation failed: Start block (200) is after end block (100) for contract 'SP123.token'.\n  at [0]",
      }),
    );
  });

  test("resolves endBlock: 'latest' using API status and bounds synchronization", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];

    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);

      return Effect.void;
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.endsWith("/extended")) {
        return {
          statusCode: 200,
          body: mockBody({
            server_version: "stacks-node-api:v1.0.0",
            status: "ready",
            chain_tip: {
              block_height: 100,
              block_hash: "block-100",
              index_block_hash: "idx-100",
              microblock_hash: "mb-100",
              microblock_sequence: 0,
            },
          }),
        };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "100:0:0" },
            results: [{ transaction: { tx_id: "tx-100", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-100",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-100",
              height: 100,
              time: 1000,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 100,
              time: 1000,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-100",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });

    const result = await runtime.run([
      { contractId, handler, startBlock: 100, endBlock: "latest" },
    ]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([100]);
  });

  test("returns error when endBlock: 'latest' fails to fetch API status", async () => {
    const contractId = "SP123.token";
    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.endsWith("/extended")) {
        return {
          statusCode: 500,
          body: mockBody({ error: "Internal Server Error" }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });

    const result = await Effect.runPromiseExit(
      runtime.run([{ contractId, handler: noopHandler, endBlock: "latest" }]),
    );

    expect(Exit.isFailure(result)).toBe(true);
  });

  test("skips sync and network requests when contract is already marked complete for endBlock", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockReturnValue(Effect.void);

    // Pre-populate sync progress as complete up to block 150
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 150,
        isComplete: true,
      }),
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      throw new Error(`Unexpected network request: ${rawUrl}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 150 }]);

    expect(result).toBeDefined();
    expect(mockRequest).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test("resumes sync when contract was marked complete for lower endBlock and new run has higher endBlock", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];

    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);

      return Effect.void;
    });

    // Contract was completed up to block 100 in previous run
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 100,
        isComplete: true,
      }),
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        // Starts discovering from block 101
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "150:0:0" },
            results: [{ transaction: { tx_id: "tx-150", block: { height: 150, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-150/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=150:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-150",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-150")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-150",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-150",
              height: 150,
              time: 1500,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 150,
              time: 1500,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-150")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 150,
            hash: "block-150",
            block_time: 1500,
            block_time_iso: "",
            tenure_height: 150,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1500,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 150,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 200 }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([150]);

    const progress = await testDb.run(syncStore.getSyncProgress({ contractId, chainId: 1 }));
    expect(progress).toMatchObject({
      cursor: null,
      isComplete: true,
      lastBlockHeight: 150n,
    });
  });

  test("resumes sync across consecutive runs with no endBlock instead of skipping", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];

    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);

      return Effect.void;
    });

    // Contract was synced up to block 100 in an earlier unbounded run (isComplete: false, cursor: null)
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "150:0:0" },
            results: [{ transaction: { tx_id: "tx-150", block: { height: 150, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-150/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=150:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-150",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-150")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-150",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: {
              hash: "block-150",
              height: 150,
              time: 1500,
              tx_index: 0,
            },
            bitcoin_block: {
              height: 150,
              time: 1500,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-150")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 150,
            hash: "block-150",
            block_time: 1500,
            block_time_iso: "",
            tenure_height: 150,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1500,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 150,
            miner_txid: "",
            tx_count: 1,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([150]);

    const progress = await testDb.run(syncStore.getSyncProgress({ contractId, chainId: 1 }));
    expect(progress).toMatchObject({
      cursor: null,
      isComplete: false,
      lastBlockHeight: 150n,
    });
  });

  test("resolves block height for events whose transactions already exist in sync store", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];

    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);

      return Effect.void;
    });

    // Pre-insert block and transaction into DB
    await testDb.db.insert(blocksTable).values({
      chainId: 1n,
      height: 100n,
      hash: "block-100",
      blockTime: 1000n,
      tenureHeight: 100n,
    });
    await testDb.db.insert(transactionsTable).values({
      chainId: 1n,
      txId: "tx-1",
      blockHeight: 100n,
      blockHash: "block-100",
      txIndex: 0,
      txType: "contract_call",
      senderAddress: "SP sender",
      feeRate: 1000n,
      nonce: 0n,
      txStatus: "success",
    });

    // Pre-seed sync progress with cursor pointing to block 100
    await testDb.run(
      syncStore.upsertSyncProgress({
        contractId,
        chainId: 1,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      }),
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      // Note: /extended/v3/transactions/tx-1 should NOT be called because tx-1 is already in DB
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([100]);

    // Verify event was saved with block height 100 from existing transaction
    const savedEvents = await testDb.db.select().from(eventsTable);
    expect(savedEvents).toHaveLength(1);
    expect(Number(savedEvents[0].blockHeight)).toBe(100);
  });

  test("fetches subsequent page when initial page next_cursor jumps past endBlock to capture remaining events in bounded block", async () => {
    const contractId = "SP123.token";
    const handledEvents: { txId: string; blockHeight: number }[] = [];

    const handler = vi.fn().mockImplementation((event: { tx_id: string; block_height: number }) => {
      handledEvents.push({ txId: event.tx_id, blockHeight: event.block_height });

      return Effect.void;
    });

    const makeTx = (txId: string, blockHeight: number, txIndex: number) => ({
      tx_id: txId,
      event_count: 1,
      type: "contract_call",
      status: "success",
      fee_rate: "1000",
      sender: { address: "SP sender", nonce: 0 },
      sponsor: null,
      block: {
        hash: `block-${blockHeight}`,
        height: blockHeight,
        time: 1000,
        tx_index: txIndex,
      },
      bitcoin_block: {
        height: blockHeight,
        time: 1000,
      },
      events: [
        {
          event_index: 0,
          event_type: "smart_contract_log",
          contract_log: {
            contract_id: contractId,
            topic: "print",
            value: { hex: "", repr: "" },
          },
        },
      ],
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 3,
            cursor: { next: null, previous: null, current: "100:0:0" },
            results: [
              { transaction: { tx_id: "tx-100-3", block: { height: 100, tx_index: 30 } } },
              { transaction: { tx_id: "tx-100-2", block: { height: 100, tx_index: 20 } } },
              { transaction: { tx_id: "tx-100-1", block: { height: 100, tx_index: 10 } } },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      // Initial page: returns only the first event at tx_index 10, next_cursor jumps forward to 150
      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:10:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 3,
            next_cursor: "150:0:50:0",
            prev_cursor: null,
          }),
        };
      }

      // Page 2: returns events from block 150 down to block 100 (including tx-100-3 and tx-100-2)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=150:0:50:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-150-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
              {
                tx_id: "tx-100-3",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
              {
                tx_id: "tx-100-2",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 3,
            next_cursor: "200:0:0:0",
            prev_cursor: "100:0:10:0",
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100-1")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-100-1", 100, 10)) };
      }

      if (url.includes("/extended/v3/transactions/tx-100-2")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-100-2", 100, 20)) };
      }

      if (url.includes("/extended/v3/transactions/tx-100-3")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-100-3", 100, 30)) };
      }

      if (url.includes("/extended/v3/transactions/tx-150-1")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-150-1", 150, 50)) };
      }

      if (url.includes("/extended/v2/blocks/block-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-100",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 3,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 100 }]);

    expect(result).toBeDefined();
    // Should have processed all 3 events belonging to block 100
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handledEvents).toStrictEqual([
      { txId: "tx-100-1", blockHeight: 100 },
      { txId: "tx-100-2", blockHeight: 100 },
      { txId: "tx-100-3", blockHeight: 100 },
    ]);

    // Should NOT fetch page with cursor 200:0:0:0 because currentHeight (150) >= endBlock (100) on page 2
    const page3Calls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("cursor=200"),
    );

    expect(page3Calls).toHaveLength(0);

    // Sync progress should be marked complete for endBlock 100
    const progress = await testDb.run(syncStore.getSyncProgress({ contractId, chainId: 1 }));
    expect(progress).toMatchObject({
      cursor: null,
      isComplete: true,
      lastBlockHeight: 100n,
    });
  });

  test("fetches multiple pages within endBlock with a third cursor at the same block height", async () => {
    const contractId = "SP123.token";
    const handledEvents: { txId: string; blockHeight: number }[] = [];

    const handler = vi.fn().mockImplementation((event: { tx_id: string; block_height: number }) => {
      handledEvents.push({ txId: event.tx_id, blockHeight: event.block_height });

      return Effect.void;
    });

    const makeTx = (txId: string, blockHeight: number, txIndex: number) => ({
      tx_id: txId,
      event_count: 1,
      type: "contract_call",
      status: "success",
      fee_rate: "1000",
      sender: { address: "SP sender", nonce: 0 },
      sponsor: null,
      block: {
        hash: `block-${blockHeight}`,
        height: blockHeight,
        time: 1000,
        tx_index: txIndex,
      },
      bitcoin_block: {
        height: blockHeight,
        time: 1000,
      },
      events: [
        {
          event_index: 0,
          event_type: "smart_contract_log",
          contract_log: {
            contract_id: contractId,
            topic: "print",
            value: { hex: "", repr: "" },
          },
        },
      ],
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) => standardTxById[id])
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 3,
            cursor: { next: null, previous: null, current: "100:0:0" },
            results: [
              { transaction: { tx_id: "tx-100-3", block: { height: 100, tx_index: 30 } } },
              { transaction: { tx_id: "tx-100-2", block: { height: 100, tx_index: 20 } } },
              { transaction: { tx_id: "tx-100-1", block: { height: 100, tx_index: 10 } } },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      // Page 1: block 100, tx 10 -> next_cursor: 100:0:20:0 (second page in block 100)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:10:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 3,
            next_cursor: "100:0:20:0",
            prev_cursor: null,
          }),
        };
      }

      // Page 2: block 100, tx 20 -> next_cursor: 100:0:30:0 (third cursor in same block 100)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:20:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100-2",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 3,
            next_cursor: "100:0:30:0",
            prev_cursor: "100:0:10:0",
          }),
        };
      }

      // Page 3: block 100, tx 30 -> next_cursor: 150:0:50:0 (jumps to block 150)
      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=100:0:30:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-100-3",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 3,
            next_cursor: "150:0:50:0",
            prev_cursor: "100:0:20:0",
          }),
        };
      }

      // Page 4: block 150 -> next_cursor: 200:0:0:0
      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=150:0:50:0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-150-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: "200:0:0:0",
            prev_cursor: "100:0:30:0",
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-100-1")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-100-1", 100, 10)) };
      }

      if (url.includes("/extended/v3/transactions/tx-100-2")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-100-2", 100, 20)) };
      }

      if (url.includes("/extended/v3/transactions/tx-100-3")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-100-3", 100, 30)) };
      }

      if (url.includes("/extended/v3/transactions/tx-150-1")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-150-1", 150, 50)) };
      }

      if (url.includes("/extended/v2/blocks/block-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-100",
            block_time: 1000,
            block_time_iso: "",
            tenure_height: 100,
            index_block_hash: "",
            parent_block_hash: "",
            parent_index_block_hash: "",
            burn_block_time: 1000,
            burn_block_time_iso: "",
            burn_block_hash: "",
            burn_block_height: 100,
            miner_txid: "",
            tx_count: 3,
            execution_cost_read_count: 0,
            execution_cost_read_length: 0,
            execution_cost_runtime: 0,
            execution_cost_write_count: 0,
            execution_cost_write_length: 0,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 100 }]);

    expect(result).toBeDefined();
    // Should have processed all 3 events across the multiple pages in block 100
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handledEvents).toStrictEqual([
      { txId: "tx-100-1", blockHeight: 100 },
      { txId: "tx-100-2", blockHeight: 100 },
      { txId: "tx-100-3", blockHeight: 100 },
    ]);

    // Should NOT fetch page with cursor 200:0:0:0
    const page5Calls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("cursor=200"),
    );

    expect(page5Calls).toHaveLength(0);

    // Sync progress should be marked complete for endBlock 100
    const progress = await testDb.run(syncStore.getSyncProgress({ contractId, chainId: 1 }));
    expect(progress).toMatchObject({
      cursor: null,
      isComplete: true,
      lastBlockHeight: 100n,
    });
  });

  test("rejects invalid custom networks", async () => {
    const invalidNetworks = [
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 1,
      Number.MIN_SAFE_INTEGER - 1,
    ];

    for (const network of invalidNetworks) {
      const runtime = makeRuntime({ db: testDb.db, network });

      const error = await Effect.runPromise(
        runtime.run([{ contractId: "SP123.token", handler: noopHandler }]).pipe(Effect.flip),
      );

      expect(Predicate.isTagged(error, "ConfigurationError")).toBe(true);
    }
  });

  test("supports custom network in context", async () => {
    const contractId = "SP123.custom-chain";
    const customChainId = 2147483648;
    const handler = vi.fn().mockReturnValue(Effect.void);

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes("/extended/v3/transactions/batch")) {
        const results = parseBatchIds(url)
          .map((id) =>
            id === "tx-1"
              ? {
                  tx_id: "tx-1",
                  block: { height: 50, hash: "block-50", tx_index: 0 },
                  bitcoin_block: { height: 50, time: 1000 },
                  type: "contract_call",
                  sender: { address: "SP_SENDER", nonce: 1 },
                  fee_rate: 100,
                  status: "success",
                }
              : standardTxById[id],
          )
          .filter(Boolean);

        return { statusCode: 200, body: mockBody({ results }) };
      }

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 50 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 50, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "0x01", repr: "u1" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v2/smart-contracts") && url.includes("/logs")) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 100,
            total: 1,
            results: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
                tx_id: "tx-1",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "0x01", repr: "u1" },
                },
              },
            ],
            next_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            block: { height: 50, hash: "block-50", tx_index: 0 },
            type: "contract_call",
            sender: { address: "SP_SENDER", nonce: 1 },
            fee_rate: 100,
            status: "success",
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-50")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 50,
            hash: "block-50",
            burn_block_time: 1000,
            burn_block_height: 50,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
      network: customChainId,
    });

    const result = await runtime.run([{ contractId, handler }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(1);

    const progress = await testDb.run(
      syncStore.getSyncProgress({ contractId, chainId: customChainId }),
    );

    expect(progress).not.toBeNull();
    expect(progress?.chainId).toBe(BigInt(customChainId));

    const checkpoint = await testDb.run(syncStore.getCheckpoint({ chainId: customChainId }));
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.chainId).toBe(BigInt(customChainId));
    expect(checkpoint?.blockHeight).toBe(50n);

    // Verify chainId: 1 has no records
    const defaultProgress = await testDb.run(syncStore.getSyncProgress({ contractId, chainId: 1 }));

    expect(defaultProgress).toBeNull();
  });

  test('network "testnet" uses the testnet chain ID and API', async () => {
    const contractId = "SP123.testnet";
    const requestedUrls: string[] = [];

    mockRequest.mockImplementation((rawUrl: string) => {
      requestedUrls.push(rawUrl);
      const url = decodeURIComponent(rawUrl);

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({ contract_id: contractId, block: { height: 50 }, tx_id: "tx-deploy" }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 0,
            cursor: { next: null, previous: null, current: "curr" },
            results: [],
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
      network: "testnet",
    });

    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result).toBeDefined();
    expect(requestedUrls.length).toBeGreaterThan(0);

    for (const requestedUrl of requestedUrls) {
      expect(new URL(requestedUrl).origin).toBe("https://api.testnet.hiro.so");
    }

    const progress = await testDb.run(
      syncStore.getSyncProgress({ contractId, chainId: 2_147_483_648 }),
    );

    expect(progress).not.toBeNull();
    expect(progress?.chainId).toBe(2_147_483_648n);
  });

  test("explicit api.baseUrl overrides the network default", async () => {
    const contractId = "SP123.override";
    const requestedUrls: string[] = [];

    mockRequest.mockImplementation((rawUrl: string) => {
      requestedUrls.push(rawUrl);
      const url = decodeURIComponent(rawUrl);

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({ contract_id: contractId, block: { height: 50 }, tx_id: "tx-deploy" }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 0,
            cursor: { next: null, previous: null, current: "curr" },
            results: [],
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({
      db: testDb.db,
      network: "testnet",
      api: { baseUrl: "https://custom.example" },
    });

    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result).toBeDefined();
    expect(requestedUrls.length).toBeGreaterThan(0);

    for (const requestedUrl of requestedUrls) {
      expect(new URL(requestedUrl).origin).toBe("https://custom.example");
    }

    const progress = await testDb.run(
      syncStore.getSyncProgress({ contractId, chainId: 2_147_483_648 }),
    );

    expect(progress).not.toBeNull();
  });

  test("fetches multiple transactions via batch endpoint in a single request", async () => {
    const contractId = "SP123.batch";
    const handler = vi.fn().mockReturnValue(Effect.void);

    const makeTx = (txId: string, height: number, hash: string) => ({
      tx_id: txId,
      type: "contract_call",
      status: "success",
      fee_rate: "1000",
      sender: { address: "SP sender", nonce: 0 },
      sponsor: null,
      block: { hash, height, time: 1000, tx_index: 0 },
      bitcoin_block: { height, time: 1000 },
    });

    const makeBlock = (height: number, hash: string) => ({
      height,
      hash,
      block_time: 1,
      block_time_iso: "",
      tenure_height: 1,
      index_block_hash: "",
      parent_block_hash: "",
      parent_index_block_hash: "",
      burn_block_time: 1,
      burn_block_time_iso: "",
      burn_block_hash: "",
      burn_block_height: 1,
      miner_txid: "",
      tx_count: 1,
      execution_cost_read_count: 0,
      execution_cost_read_length: 0,
      execution_cost_runtime: 0,
      execution_cost_write_count: 0,
      execution_cost_write_length: 0,
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({ contract_id: contractId, block: { height: 100 }, tx_id: "tx-deploy" }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1") && !url.includes("/batch")) {
        return { statusCode: 200, body: mockBody(makeTx("tx-1", 100, "block-1")) };
      }

      if (url.includes(`/extended/v2/smart-contracts/${contractId}/logs`)) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-2",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            limit: 100,
            offset: 0,
            total: 2,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/batch")) {
        // Batch returns newest-first regardless of request order
        return {
          statusCode: 200,
          body: mockBody({
            results: [makeTx("tx-2", 200, "block-2"), makeTx("tx-1", 100, "block-1")],
          }),
        };
      }

      if (url.includes("/extended/v2/blocks/block-1")) {
        return { statusCode: 200, body: mockBody(makeBlock(100, "block-1")) };
      }

      if (url.includes("/extended/v2/blocks/block-2")) {
        return { statusCode: 200, body: mockBody(makeBlock(200, "block-2")) };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result).toBeDefined();
    expect(handler).toHaveBeenCalledTimes(2);

    const batchCalls = mockRequest.mock.calls.filter((call: any) =>
      String(call[0]).includes("/extended/v3/transactions/batch"),
    );

    expect(batchCalls).toHaveLength(1);

    const singleTxCalls = mockRequest.mock.calls.filter(
      (call: any) =>
        String(call[0]).includes("/extended/v3/transactions/tx-") &&
        !String(call[0]).includes("/events") &&
        !String(call[0]).includes("/batch"),
    );

    // Tx-1 single fetch happens once during cursor discovery; tx-2 must come from batch only
    expect(singleTxCalls.filter((call: any) => String(call[0]).includes("tx-2"))).toHaveLength(0);

    const storedTxs = await testDb.db.select().from(transactionsTable);
    expect(storedTxs).toHaveLength(2);
  });

  test("returns error when batch omits a transaction", async () => {
    const contractId = "SP123.batch-missing";
    const handler = vi.fn().mockReturnValue(Effect.void);

    const tx1 = {
      tx_id: "tx-1",
      type: "contract_call",
      status: "success",
      fee_rate: "1000",
      sender: { address: "SP sender", nonce: 0 },
      sponsor: null,
      block: { hash: "block-1", height: 100, time: 1000, tx_index: 0 },
      bitcoin_block: { height: 100, time: 1000 },
    };

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({ contract_id: contractId, block: { height: 100 }, tx_id: "tx-deploy" }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1") && !url.includes("/batch")) {
        return { statusCode: 200, body: mockBody(tx1) };
      }

      if (url.includes(`/extended/v2/smart-contracts/${contractId}/logs`)) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
              {
                tx_id: "tx-2",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            next_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/batch")) {
        // Tx-2 omitted (unknown or mempool)
        return { statusCode: 200, body: mockBody({ results: [tx1] }) };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await Effect.runPromiseExit(runtime.run([{ contractId, handler }]));

    expect(result).toBeTaggedError(new TransactionBatchError({ missingIds: ["tx-2"] }));
    expect(handler).not.toHaveBeenCalled();
  });

  test("returns error when batch request fails", async () => {
    const contractId = "SP123.batch-error";
    const handler = vi.fn().mockReturnValue(Effect.void);

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);

      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({ contract_id: contractId, block: { height: 100 }, tx_id: "tx-deploy" }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/tx-1") && !url.includes("/batch")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP sender", nonce: 0 },
            sponsor: null,
            block: { hash: "block-1", height: 100, time: 1000, tx_index: 0 },
            bitcoin_block: { height: 100, time: 1000 },
            events: [],
          }),
        };
      }

      if (url.includes(`/extended/v2/smart-contracts/${contractId}/logs`)) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [
              {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
            next_cursor: null,
          }),
        };
      }

      if (url.includes("/extended/v3/transactions/batch")) {
        return {
          statusCode: 400,
          statusText: "Bad Request",
          body: mockBody({ error: "boom" }),
          headers: { "content-type": "application/json" },
        };
      }

      if (url.includes("/extended/v2/blocks/block-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            height: 100,
            hash: "block-1",
            burn_block_time: 1,
            burn_block_height: 1,
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = makeRuntime({ db: testDb.db });
    const result = await Effect.runPromiseExit(runtime.run([{ contractId, handler }]));

    await expectStatusError(result, {
      status: 400,
      path: "/extended/v3/transactions/batch",
      body: { error: "boom" },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  test("returns SyncStoreError when a sync store operation fails", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }

      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 0,
            cursor: { next: null, previous: null, current: "" },
            results: [],
          }),
        };
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    // Force the next sync-store read to fail.
    await testDb.db.execute(sql`drop table "sync_progress"`);

    const runtime = makeRuntime({ db: testDb.db });
    const result = await Effect.runPromiseExit(runtime.run([{ contractId, handler: noopHandler }]));

    expect(result).toBeTaggedError(new SyncStoreError({ operation: "getSyncProgress" }));
  });
});
