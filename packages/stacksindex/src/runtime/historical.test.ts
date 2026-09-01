// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable typescript/no-explicit-any
// oxlint-disable jest/no-conditional-in-test
// oxlint-disable jest/max-expects
// oxlint-disable vitest/prefer-called-once, vitest/prefer-called-times
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createDatabase } from "../database/index.ts";
import { createLogger } from "../logger/index.ts";
import { parseLogsCursor, parseTransactionCursor } from "../sync-historical/index.ts";
import { syncStore } from "../sync-store/index.ts";
import {
  blocksTable,
  checkpointsTable,
  eventsTable,
  transactionsTable,
} from "../sync-store/schema.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { createHistoricalRuntime } from "./historical.ts";

const mockRequest = vi.hoisted(() => vi.fn());

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: mockRequest,
}));

const context = {
  logger: createLogger({ level: 0 }),
};

const noopHandler = () => Promise.resolve();

const mockBody = (data: unknown) => ({
  json: () => Promise.resolve(data),
});

describe("historical runtime", () => {
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

  test("fetches and stores blocks and transactions for a single contract", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isOk()).toBe(true);

    // Verify blocks stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(2);
    expect(blocks.map((row) => Number(row.height))).toContain(100);
    expect(blocks.map((row) => Number(row.height))).toContain(200);

    // Verify transactions stored
    const transactions = await testDb.db.select().from(transactionsTable);
    expect(transactions).toHaveLength(2);

    // Verify sync progress
    const progress = await syncStore.getSyncProgress({ contractId, chainId: 1 }, { db: testDb.db });
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

    const txMap: Record<string, any> = {
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
        canonical: true,
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
      if (url.includes(`/extended/v1/contract/${contractA}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractA,
            block_height: 100,
            tx_id: "tx-a-deploy",
            canonical: true,
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
      if (url.includes(`/extended/v1/contract/${contractB}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractB,
            block_height: 50,
            tx_id: "tx-b-deploy",
            canonical: true,
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

      for (const [txId, txData] of Object.entries(txMap)) {
        if (url.includes(`/extended/v3/transactions/${txId}/events`)) {
          const events = (txData.events ?? []) as {
            event_index: number;
            event_type?: string;
            contract_log?: unknown;
          }[];
          return {
            statusCode: 200,
            body: mockBody({
              total: events.length,
              limit: 50,
              cursor: { next: null, previous: null, current: "0" },
              results: events.map((event) => ({
                event_index: event.event_index,
                type: event.event_type === "smart_contract_log" ? "contract_log" : event.event_type,
                ...(event.event_type === "smart_contract_log"
                  ? { contract_log: event.contract_log }
                  : {}),
              })),
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([
      { contractId: contractA, handler: noopHandler },
      { contractId: contractB, handler: noopHandler },
    ]);

    expect(result.isOk()).toBe(true);

    // Verify fair scheduling by checking the order of getContractLogs calls
    const logsCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/logs?limit=100&cursor="),
    );
    expect(logsCalls).toHaveLength(4);

    // B starts at 50, A at 100 -> B should go first
    expect(decodeURIComponent(logsCalls[0][0] as string)).toContain("cursor=50:0:0:0");
    expect(logsCalls[0][0]).toContain(contractB);

    // After B advances to 150, A is at 100 -> A should go next
    expect(decodeURIComponent(logsCalls[1][0] as string)).toContain("cursor=100:0:0:0");
    expect(logsCalls[1][0]).toContain(contractA);

    // A advances to 200, B is at 150 -> B should go next
    expect(decodeURIComponent(logsCalls[2][0] as string)).toContain("cursor=150:0:0:0");
    expect(logsCalls[2][0]).toContain(contractB);

    // Finally A at 200
    expect(decodeURIComponent(logsCalls[3][0] as string)).toContain("cursor=200:0:0:0");
    expect(logsCalls[3][0]).toContain(contractA);
  });

  test("resumes from saved cursor without refetching first cursor", async () => {
    const contractId = "SP123.token";

    // Pre-seed sync progress
    await syncStore.upsertSyncProgress(
      { contractId, chainId: 1, cursor: "100:0:0:0", lastBlockHeight: 100 },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isOk()).toBe(true);

    // Should not have called getPrincipalTransactions (first cursor discovery)
    const addressTxCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/principals/"),
    );
    expect(addressTxCalls).toHaveLength(0);

    // Blocks and transactions should be stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(1);
  });

  test("skips API calls for transactions and blocks already in database", async () => {
    const contractId = "SP123.token";

    // Pre-seed sync progress, transaction, and block
    await syncStore.upsertSyncProgress(
      { contractId, chainId: 1, cursor: "100:0:0:0", lastBlockHeight: 100 },
      { db: testDb.db },
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
      canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isOk()).toBe(true);

    // Verify no getTransaction or getBlock calls were made
    const txCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/extended/v3/transactions/"),
    );
    const blockCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/extended/v2/blocks/"),
    );
    expect(txCalls).toHaveLength(0);
    expect(blockCalls).toHaveLength(0);
  });

  test("returns error when getContractLogs fails", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isErr()).toBe(true);
  });

  test("completes immediately when contract has no events", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isOk()).toBe(true);

    // Nothing should be stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(0);
  });

  test("skips non-smart_contract_log events without crashing", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isOk()).toBe(true);

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
  test("parses valid logs cursor", () => {
    const result = parseLogsCursor("100:0:5:2");
    expect(result).toStrictEqual({
      blockHeight: 100,
      microblockSequence: 0,
      txIndex: 5,
      eventIndex: 2,
    });
  });

  test("throws on invalid logs cursor format", () => {
    expect(() => parseLogsCursor("invalid")).toThrow("Invalid logs cursor format: invalid");
    expect(() => parseLogsCursor("100:0:5:2:1")).toThrow("Invalid logs cursor format: 100:0:5:2:1");
    expect(() => parseLogsCursor("100:0:5")).toThrow("Invalid logs cursor format: 100:0:5");
  });

  test("parses valid transaction cursor", () => {
    const result = parseTransactionCursor("100:0:5");
    expect(result).toStrictEqual({
      blockHeight: 100,
      microblockSequence: 0,
      txIndex: 5,
    });
  });

  test("throws on invalid transaction cursor format", () => {
    expect(() => parseTransactionCursor("invalid")).toThrow(
      "Invalid transaction cursor format: invalid",
    );
    expect(() => parseTransactionCursor("100:0:5:2")).toThrow(
      "Invalid transaction cursor format: 100:0:5:2",
    );
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
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);

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

    const txMap: Record<string, any> = {
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
        canonical: true,
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
      if (url.includes(`/extended/v1/contract/${contractA}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractA,
            block_height: 100,
            tx_id: "tx-a-deploy",
            canonical: true,
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
      if (url.includes(`/extended/v1/contract/${contractB}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractB,
            block_height: 50,
            tx_id: "tx-b-deploy",
            canonical: true,
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

      for (const [txId, txData] of Object.entries(txMap)) {
        if (url.includes(`/extended/v3/transactions/${txId}/events`)) {
          const events = (txData.events ?? []) as {
            event_index: number;
            event_type?: string;
            contract_log?: unknown;
          }[];
          return {
            statusCode: 200,
            body: mockBody({
              total: events.length,
              limit: 50,
              cursor: { next: null, previous: null, current: "0" },
              results: events.map((event) => ({
                event_index: event.event_index,
                type: event.event_type === "smart_contract_log" ? "contract_log" : event.event_type,
                ...(event.event_type === "smart_contract_log"
                  ? { contract_log: event.contract_log }
                  : {}),
              })),
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

    const runtime = createHistoricalRuntime({
      logger: context.logger,
      db: testDb.db,
    });
    const result = await runtime.run([
      { contractId: contractA, handler: handlerA },
      { contractId: contractB, handler: handlerB },
    ]);

    expect(result.isOk()).toBe(true);

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
    const handler = vi.fn().mockResolvedValue(undefined);

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({
      logger: context.logger,
      db: testDb.db,
    });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    // Verify checkpoint was updated
    const checkpoint = await testDb.db.select().from(checkpointsTable);
    expect(checkpoint).toHaveLength(1);
    expect(Number(checkpoint[0].blockHeight)).toBe(100);
    expect(Number(checkpoint[0].blockTime)).toBe(1000);
  });

  test("does not re-process events below checkpoint on restart", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockResolvedValue(undefined);

    // Pre-seed checkpoint so block 100 is already processed
    await syncStore.upsertCheckpoint(
      { chainId: 1, blockHeight: 100, blockTime: 1000 },
      { db: testDb.db },
    );
    // Pre-seed sync progress so it skips first cursor discovery
    await syncStore.upsertSyncProgress(
      { contractId, chainId: 1, cursor: "100:0:0:0", lastBlockHeight: 100 },
      { db: testDb.db },
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
      canonical: true,
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
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

    const runtime = createHistoricalRuntime({
      logger: context.logger,
      db: testDb.db,
    });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result.isOk()).toBe(true);
    // Handler should NOT be called because the event is at block 100 which is already checkpointed
    expect(handler).not.toHaveBeenCalled();
  });

  test("returns error when handler throws", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockRejectedValue(new Error("Handler failed"));

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({
      logger: context.logger,
      db: testDb.db,
    });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result.isErr()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("uses custom baseUrl and apiKey when provided to runtime", async () => {
    const contractId = "SP123.token";
    const customBaseUrl = "https://custom-stacks.example.com";
    const customApiKey = "test-api-key-123";

    mockRequest.mockImplementation((rawUrl: string, init: { headers: Record<string, string> }) => {
      const url = decodeURIComponent(rawUrl);
      expect(url.startsWith(customBaseUrl)).toBe(true);
      expect(init.headers["x-api-key"]).toBe(customApiKey);

      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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

    const runtime = createHistoricalRuntime({
      logger: context.logger,
      db: testDb.db,
      api: {
        baseUrl: customBaseUrl,
        apiKey: customApiKey,
      },
    });

    const result = await runtime.run([{ contractId, handler: noopHandler }]);
    expect(result.isOk()).toBe(true);
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

        if (url.includes(`/extended/v1/contract/${contractId}`)) {
          return {
            statusCode: 200,
            body: mockBody({
              contract_id: contractId,
              block_height: 1234,
              tx_id: "tx-deploy",
              canonical: true,
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
              canonical: true,
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

    const runtime = createHistoricalRuntime({
      logger: context.logger,
      db: testDb.db,
      api: {
        baseUrl: customBaseUrl,
        apiKey: customApiKey,
      },
    });

    const result = await runtime.run([
      {
        contractId,
        handler: async (_event, { client }) => {
          handlerCalled = true;
          const [contractAddress, contractName] = contractId.split(".");
          const readResult = await client.callReadOnly({
            contractAddress,
            contractName,
            functionName: "get-total-supply",
          });
          if (readResult.isOk() && readResult.value.okay) {
            callReadOnlySuccess = true;
          }
        },
      },
    ]);

    expect(result.isOk()).toBe(true);
    expect(handlerCalled).toBe(true);
    expect(callReadOnlySuccess).toBe(true);
    expect(callReadOnlyUrl).toBe(
      `${customBaseUrl}/v2/contracts/call-read/SP123/token/get-total-supply?tip=1234`,
    );
    expect(callReadOnlyApiKey).toBe(customApiKey);
  });

  test("initializes runtime with database created from createDatabase and cleans up on close", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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

    const indexerDb = await createDatabase({ kind: "pglite" });

    const runtime = createHistoricalRuntime({
      logger: context.logger,
      db: indexerDb.db,
    });

    const result = await runtime.run([{ contractId, handler: noopHandler }]);
    expect(result.isOk()).toBe(true);

    await indexerDb.close();
  });

  test("filters events and starts synchronization at startBlock", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];
    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);
      return Promise.resolve();
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100 }]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([100]);
  });

  test("filters events and bounds synchronization with startBlock and endBlock", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];
    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);
      return Promise.resolve();
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 150 }]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handledHeights).toStrictEqual([100, 150]);
  });

  test("skips contract synchronization when initial event exceeds endBlock", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn();

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, endBlock: 100 }]);

    expect(result.isOk()).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  test("does not collect transactions or fetch blocks for transactions exceeding maxBlockHeight", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockResolvedValue(undefined);

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 150 }]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    // Block-200 should not have been fetched
    const block200Calls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/extended/v2/blocks/block-200"),
    );
    expect(block200Calls).toHaveLength(0);
  });

  test("rejects invalid startBlock (negative or non-integer)", async () => {
    const contractId = "SP123.token";
    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });

    const negativeResult = await runtime.run([
      { contractId, handler: noopHandler, startBlock: -1 },
    ]);
    expect(negativeResult.isErr()).toBe(true);
    const negativeError = negativeResult.isErr() ? negativeResult.error : null;
    expect(negativeError).toMatchObject({
      name: "FilterValidationError",
      message: expect.stringContaining("Invalid startBlock"),
    });

    const floatResult = await runtime.run([{ contractId, handler: noopHandler, startBlock: 1.5 }]);
    expect(floatResult.isErr()).toBe(true);
    const floatError = floatResult.isErr() ? floatResult.error : null;
    expect(floatError).toMatchObject({
      name: "FilterValidationError",
      message: expect.stringContaining("Invalid startBlock"),
    });
  });

  test("rejects invalid endBlock (negative or non-integer)", async () => {
    const contractId = "SP123.token";
    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });

    const negativeResult = await runtime.run([{ contractId, handler: noopHandler, endBlock: -5 }]);
    expect(negativeResult.isErr()).toBe(true);
    const negativeError = negativeResult.isErr() ? negativeResult.error : null;
    expect(negativeError).toMatchObject({
      name: "FilterValidationError",
      message: expect.stringContaining("Invalid endBlock"),
    });

    const floatResult = await runtime.run([{ contractId, handler: noopHandler, endBlock: 100.2 }]);
    expect(floatResult.isErr()).toBe(true);
    const floatError = floatResult.isErr() ? floatResult.error : null;
    expect(floatError).toMatchObject({
      name: "FilterValidationError",
      message: expect.stringContaining("Invalid endBlock"),
    });
  });

  test("rejects when startBlock is greater than endBlock", async () => {
    const contractId = "SP123.token";
    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });

    const result = await runtime.run([
      { contractId, handler: noopHandler, startBlock: 200, endBlock: 100 },
    ]);
    expect(result.isErr()).toBe(true);
    const resultError = result.isErr() ? result.error : null;
    expect(resultError).toMatchObject({
      name: "FilterValidationError",
      message: expect.stringContaining("Start block (200) is after end block (100)"),
    });
  });

  test("resolves endBlock: 'latest' using API status and bounds synchronization", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];
    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);
      return Promise.resolve();
    });

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("/extended/v1/status")) {
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
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([
      { contractId, handler, startBlock: 100, endBlock: "latest" },
    ]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([100]);
  });

  test("returns error when endBlock: 'latest' fails to fetch API status", async () => {
    const contractId = "SP123.token";
    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes("/extended/v1/status")) {
        return {
          statusCode: 500,
          body: mockBody({ error: "Internal Server Error" }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler, endBlock: "latest" }]);

    expect(result.isErr()).toBe(true);
  });

  test("skips sync and network requests when contract is already marked complete for endBlock", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockResolvedValue(undefined);

    // Pre-populate sync progress as complete up to block 150
    await syncStore.upsertSyncProgress(
      {
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 150,
        isComplete: true,
      },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      throw new Error(`Unexpected network request: ${rawUrl}`);
    });

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 150 }]);

    expect(result.isOk()).toBe(true);
    expect(mockRequest).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  test("resumes sync when contract was marked complete for lower endBlock and new run has higher endBlock", async () => {
    const contractId = "SP123.token";
    const handledHeights: number[] = [];
    const handler = vi.fn().mockImplementation((event: { block_height: number }) => {
      handledHeights.push(event.block_height);
      return Promise.resolve();
    });

    // Contract was completed up to block 100 in previous run
    await syncStore.upsertSyncProgress(
      {
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 100,
        isComplete: true,
      },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 200 }]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([150]);

    const progress = await syncStore.getSyncProgress({ contractId, chainId: 1 }, { db: testDb.db });
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
      return Promise.resolve();
    });

    // Contract was synced up to block 100 in an earlier unbounded run (isComplete: false, cursor: null)
    await syncStore.upsertSyncProgress(
      {
        contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: 100,
        isComplete: false,
      },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handledHeights).toStrictEqual([150]);

    const progress = await syncStore.getSyncProgress({ contractId, chainId: 1 }, { db: testDb.db });
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
      return Promise.resolve();
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
      canonical: true,
    });

    // Pre-seed sync progress with cursor pointing to block 100
    await syncStore.upsertSyncProgress(
      {
        contractId,
        chainId: 1,
        cursor: "100:0:0:0",
        lastBlockHeight: 100,
        isComplete: false,
      },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((rawUrl: string) => {
      const url = decodeURIComponent(rawUrl);
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result.isOk()).toBe(true);
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
      return Promise.resolve();
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
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 100 }]);

    expect(result.isOk()).toBe(true);
    // Should have processed all 3 events belonging to block 100
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handledEvents).toStrictEqual([
      { txId: "tx-100-1", blockHeight: 100 },
      { txId: "tx-100-2", blockHeight: 100 },
      { txId: "tx-100-3", blockHeight: 100 },
    ]);

    // Should NOT fetch page with cursor 200:0:0:0 because currentHeight (150) >= endBlock (100) on page 2
    const page3Calls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("cursor=200"),
    );
    expect(page3Calls).toHaveLength(0);

    // Sync progress should be marked complete for endBlock 100
    const progress = await syncStore.getSyncProgress({ contractId, chainId: 1 }, { db: testDb.db });
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
      return Promise.resolve();
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
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 50,
            tx_id: "tx-deploy",
            canonical: true,
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
            canonical: true,
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

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 100, endBlock: 100 }]);

    expect(result.isOk()).toBe(true);
    // Should have processed all 3 events across the multiple pages in block 100
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handledEvents).toStrictEqual([
      { txId: "tx-100-1", blockHeight: 100 },
      { txId: "tx-100-2", blockHeight: 100 },
      { txId: "tx-100-3", blockHeight: 100 },
    ]);

    // Should NOT fetch page with cursor 200:0:0:0
    const page5Calls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("cursor=200"),
    );
    expect(page5Calls).toHaveLength(0);

    // Sync progress should be marked complete for endBlock 100
    const progress = await syncStore.getSyncProgress({ contractId, chainId: 1 }, { db: testDb.db });
    expect(progress).toMatchObject({
      cursor: null,
      isComplete: true,
      lastBlockHeight: 100n,
    });
  });
});
