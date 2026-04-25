// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-explicit-any
// oxlint-disable max-lines
// oxlint-disable jest/no-conditional-in-test
// oxlint-disable jest/max-expects
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createLogger } from "../logger/index.ts";
import { parseCursor } from "../sync-historical/index.ts";
import { syncStore } from "../sync-store/index.ts";
import { blocksTable, transactionsTable } from "../sync-store/schema.ts";
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

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/address/${contractId}/transactions?limit=1`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 1,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-1", event_count: 1 }],
          }),
        };
      }
      if (url.includes(`/extended/v1/address/${contractId}/transactions?limit=50`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-1", event_count: 1 }],
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            block_height: 100,
            block_hash: "block-1",
            microblock_sequence: 0,
            tx_index: 0,
            sender_address: "SP sender",
            fee_rate: "1000",
            nonce: 0,
            tx_status: "success",
            tx_type: "contract_call",
            canonical: true,
            event_count: 1,
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
                contract_id: contractId,
                topic: "print",
                value: { hex: "", repr: "" },
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
                contract_id: contractId,
                topic: "print",
                value: { hex: "", repr: "" },
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
      if (url.includes("/extended/v1/tx/tx-2")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-2",
            block_height: 200,
            block_hash: "block-2",
            microblock_sequence: 0,
            tx_index: 0,
            sender_address: "SP sender",
            fee_rate: "1000",
            nonce: 0,
            tx_status: "success",
            tx_type: "contract_call",
            canonical: true,
            event_count: 1,
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
    const result = await runtime.run([{ contractId }]);

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
    expect(progress.cursor).toBe("200:0:0:0");
    expect(Number(progress.lastBlockHeight)).toBe(200);
  });

  test("schedules multiple contracts fairly by block height", async () => {
    const contractA = "SP123.token-a";
    const contractB = "SP456.token-b";

    const makeTxResponse = ({
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
      statusCode: 200,
      body: mockBody({
        tx_id: txId,
        block_height: blockHeight,
        block_hash: blockHash,
        microblock_sequence: 0,
        tx_index: 0,
        sender_address: "SP sender",
        fee_rate: "1000",
        nonce: 0,
        tx_status: "success",
        tx_type: "contract_call",
        canonical: true,
        event_count: 1,
        events: [
          {
            event_index: 0,
            event_type: "smart_contract_log",
            contract_log: { contract_id: contractId, topic: "print", value: { hex: "", repr: "" } },
          },
        ],
      }),
    });

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

    mockRequest.mockImplementation((url: string) => {
      // Contract A initialization
      if (url.includes(`/extended/v1/address/${contractA}/transactions?limit=1`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 1,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-a-init", event_count: 1 }],
          }),
        };
      }
      if (url.includes(`/extended/v1/address/${contractA}/transactions?limit=50`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-a-init", event_count: 1 }],
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-a-init")) {
        return makeTxResponse({
          txId: "tx-a-init",
          blockHeight: 100,
          blockHash: "block-a-init",
          contractId: contractA,
        });
      }

      // Contract B initialization
      if (url.includes(`/extended/v1/address/${contractB}/transactions?limit=1`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 1,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-b-init", event_count: 1 }],
          }),
        };
      }
      if (url.includes(`/extended/v1/address/${contractB}/transactions?limit=50`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-b-init", event_count: 1 }],
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-b-init")) {
        return makeTxResponse({
          txId: "tx-b-init",
          blockHeight: 50,
          blockHash: "block-b-init",
          contractId: contractB,
        });
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
              contract_id: contractA,
              topic: "print",
              value: { hex: "", repr: "" },
            },
          ],
          "200:0:0:0",
        );
      }
      if (url.includes("/extended/v1/tx/tx-a-1")) {
        return makeTxResponse({
          txId: "tx-a-1",
          blockHeight: 100,
          blockHash: "block-a-1",
          contractId: contractA,
        });
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
              contract_id: contractB,
              topic: "print",
              value: { hex: "", repr: "" },
            },
          ],
          "150:0:0:0",
        );
      }
      if (url.includes("/extended/v1/tx/tx-b-1")) {
        return makeTxResponse({
          txId: "tx-b-1",
          blockHeight: 50,
          blockHash: "block-b-1",
          contractId: contractB,
        });
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
              contract_id: contractA,
              topic: "print",
              value: { hex: "", repr: "" },
            },
          ],
          null,
        );
      }
      if (url.includes("/extended/v1/tx/tx-a-2")) {
        return makeTxResponse({
          txId: "tx-a-2",
          blockHeight: 200,
          blockHash: "block-a-2",
          contractId: contractA,
        });
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
              contract_id: contractB,
              topic: "print",
              value: { hex: "", repr: "" },
            },
          ],
          null,
        );
      }
      if (url.includes("/extended/v1/tx/tx-b-2")) {
        return makeTxResponse({
          txId: "tx-b-2",
          blockHeight: 150,
          blockHash: "block-b-2",
          contractId: contractB,
        });
      }
      if (url.includes("/extended/v2/blocks/block-b-2")) {
        return makeBlockResponse(150, "block-b-2");
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId: contractA }, { contractId: contractB }]);

    expect(result.isOk()).toBe(true);

    // Verify fair scheduling by checking the order of getContractLogs calls
    const logsCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/logs?limit=100&cursor="),
    );
    expect(logsCalls).toHaveLength(4);

    // B starts at 50, A at 100 -> B should go first
    expect(logsCalls[0][0]).toContain(`cursor=50:0:0:0`);
    expect(logsCalls[0][0]).toContain(contractB);

    // After B advances to 150, A is at 100 -> A should go next
    expect(logsCalls[1][0]).toContain(`cursor=100:0:0:0`);
    expect(logsCalls[1][0]).toContain(contractA);

    // A advances to 200, B is at 150 -> B should go next
    expect(logsCalls[2][0]).toContain(`cursor=150:0:0:0`);
    expect(logsCalls[2][0]).toContain(contractB);

    // Finally A at 200
    expect(logsCalls[3][0]).toContain(`cursor=200:0:0:0`);
    expect(logsCalls[3][0]).toContain(contractA);
  });

  test("resumes from saved cursor without refetching first cursor", async () => {
    const contractId = "SP123.token";

    // Pre-seed sync progress
    await syncStore.upsertSyncProgress(
      { contractId, chainId: 1, cursor: "100:0:0:0", lastBlockHeight: 100 },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((url: string) => {
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
                contract_id: contractId,
                topic: "print",
                value: { hex: "", repr: "" },
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
      if (url.includes("/extended/v1/tx/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            block_height: 100,
            block_hash: "block-1",
            microblock_sequence: 0,
            tx_index: 0,
            sender_address: "SP sender",
            fee_rate: "1000",
            nonce: 0,
            tx_status: "success",
            tx_type: "contract_call",
            canonical: true,
            event_count: 1,
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
    const result = await runtime.run([{ contractId }]);

    expect(result.isOk()).toBe(true);

    // Should not have called getAddressTransactions (first cursor discovery)
    const addressTxCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/address/"),
    );
    expect(addressTxCalls).toHaveLength(0);

    // Blocks and transactions should be stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(1);
  });

  test("returns error when getContractLogs fails", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/address/${contractId}/transactions?limit=1`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 1,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-1", event_count: 1 }],
          }),
        };
      }
      if (url.includes(`/extended/v1/address/${contractId}/transactions?limit=50`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-1", event_count: 1 }],
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            block_height: 100,
            block_hash: "block-1",
            microblock_sequence: 0,
            tx_index: 0,
            sender_address: "SP sender",
            fee_rate: "1000",
            nonce: 0,
            tx_status: "success",
            tx_type: "contract_call",
            canonical: true,
            event_count: 1,
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
          statusCode: 500,
          statusText: "Internal Server Error",
          body: mockBody({ error: "Logs API error" }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId }]);

    expect(result.isErr()).toBe(true);
  });

  test("completes immediately when contract has no events", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/address/${contractId}/transactions?limit=1`)) {
        return {
          statusCode: 200,
          body: mockBody({ limit: 1, offset: 0, total: 0, results: [] }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger: context.logger, db: testDb.db });
    const result = await runtime.run([{ contractId }]);

    expect(result.isOk()).toBe(true);

    // Nothing should be stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(0);
  });
});

describe("parseCursor helper", () => {
  test("parses valid cursor", () => {
    const result = parseCursor("100:0:5:2");
    expect(result).toStrictEqual({
      blockHeight: 100,
      microblockSequence: 0,
      txIndex: 5,
      eventIndex: 2,
    });
  });

  test("throws on invalid cursor format", () => {
    expect(() => parseCursor("invalid")).toThrow("Invalid cursor format: invalid");
    expect(() => parseCursor("100:0:5")).toThrow("Invalid cursor format: 100:0:5");
  });
});
