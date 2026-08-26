// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-explicit-any
// oxlint-disable jest/no-conditional-in-test
// oxlint-disable jest/max-expects
// oxlint-disable vitest/prefer-called-once, vitest/prefer-called-times
// oxlint-disable typescript/no-unsafe-return
import { URL as NodeURL } from "node:url";

import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { ClarityType } from "../indexing/clarity.ts";
import type { HandlerEvent } from "../lib/types.ts";
import { createLogger } from "../logger/index.ts";
import { parseCursor } from "../sync-historical/index.ts";
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

const logger = createLogger({ level: 0 });

const noopHandler = () => Promise.resolve();

const mockBody = (data: unknown) => ({
  json: () => Promise.resolve(data),
});

const makeBlockResponse = (height: number, hash: string) => ({
  statusCode: 200,
  body: mockBody({
    canonical: true,
    height,
    hash,
    block_time: height * 10,
    block_time_iso: "",
    tenure_height: height,
    index_block_hash: "",
    parent_block_hash: "",
    parent_index_block_hash: "",
    burn_block_time: height * 10,
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

interface MockTxInput {
  txId: string;
  blockHeight: number;
  blockHash: string;
  contractId?: string;
  includeEvent?: boolean;
}

const makeTxApiResponse = ({
  txId,
  blockHeight,
  blockHash,
  contractId,
  includeEvent,
}: MockTxInput) => ({
  tx_id: txId,
  nonce: 0,
  fee_rate: "1000",
  sender_address: "SP sender",
  sponsored: false,
  post_condition_mode: "deny",
  post_conditions: [],
  anchor_mode: "any",
  block_hash: blockHash,
  block_height: blockHeight,
  block_time: blockHeight * 10,
  block_time_iso: "",
  burn_block_time: blockHeight * 10,
  burn_block_height: blockHeight,
  burn_block_time_iso: "",
  parent_burn_block_time: 0,
  parent_burn_block_time_iso: "",
  canonical: true,
  tx_index: 0,
  tx_status: "success",
  tx_result: null,
  event_count: includeEvent ? 1 : 0,
  parent_block_hash: "",
  is_unanchored: false,
  microblock_hash: "0x",
  microblock_sequence: 0,
  microblock_canonical: true,
  execution_cost_read_count: 0,
  execution_cost_read_length: 0,
  execution_cost_runtime: 0,
  execution_cost_write_count: 0,
  execution_cost_write_length: 0,
  vm_error: null,
  events:
    includeEvent && contractId !== undefined
      ? [
          {
            event_index: 0,
            event_type: "smart_contract_log",
            contract_log: { contract_id: contractId, topic: "print", value: { hex: "", repr: "" } },
          },
        ]
      : [],
  tx_type: "contract_call",
});

/**
 * Routes `GET /extended/v1/tx/multiple?tx_id=..&tx_id=..` against a registry of
 * transaction responses so tests only declare single-tx fixtures once.
 */
const txRegistry = new Map<string, ReturnType<typeof makeTxApiResponse>>();

function registerTxs(...inputs: MockTxInput[]): void {
  for (const input of inputs) {
    txRegistry.set(input.txId, makeTxApiResponse(input));
  }
}

function handleTxMultiple(url: string): { statusCode: number; body: unknown } | undefined {
  if (!url.includes("/extended/v1/tx/multiple")) {
    return undefined;
  }
  const parsed = new NodeURL(url);
  const ids = parsed.searchParams.getAll("tx_id");
  const results: Record<string, unknown> = {};
  for (const id of ids) {
    const tx = txRegistry.get(id);
    // oxlint-disable-next-line jest/no-conditional-expect
    results[id] = tx === undefined ? { found: false, tx_id: id } : { found: true, result: tx };
  }
  return { statusCode: 200, body: mockBody(results) };
}

/** Serves `GET /extended/v1/tx/{id}` (used by first-cursor discovery). */
function handleTxSingle(url: string): { statusCode: number; body: unknown } | undefined {
  const match = /\/extended\/v1\/tx\/([^/?]+)$/u.exec(url);
  if (match === null) {
    return undefined;
  }
  const tx = txRegistry.get(match[1]);
  return tx === undefined ? undefined : { statusCode: 200, body: mockBody(tx) };
}

function handleTxRoutes(url: string): { statusCode: number; body: unknown } | undefined {
  return handleTxMultiple(url) ?? handleTxSingle(url);
}

describe("historical runtime", () => {
  // oxlint-disable-next-line init-declarations
  let testDb: TestDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    mockRequest.mockReset();
    txRegistry.clear();
    await testDb.cleanup();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await testDb.close();
  });

  test("fetches and stores blocks and transactions for a single contract", async () => {
    const contractId = "SP123.token";

    registerTxs(
      { txId: "tx-1", blockHeight: 100, blockHash: "block-1", contractId, includeEvent: true },
      { txId: "tx-2", blockHeight: 200, blockHash: "block-2" },
    );

    mockRequest.mockImplementation((url: string) => {
      const txRoute = handleTxRoutes(url);
      if (txRoute) {
        return txRoute as any;
      }
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
      if (url.includes("/extended/v2/blocks/block-1")) {
        return makeBlockResponse(100, "block-1");
      }
      if (url.includes("/extended/v2/blocks/block-2")) {
        return makeBlockResponse(200, "block-2");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
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
    expect(progress.cursor).toBe("200:0:0:0");
    expect(Number(progress.lastBlockHeight)).toBe(200);

    // Verify block time mapping uses block_time (not burn_block_time)
    const storedBlock = blocks.find((row) => Number(row.height) === 100);
    expect(Number(storedBlock?.blockTime)).toBe(1000);
    expect(Number(storedBlock?.tenureHeight)).toBe(100);
  });

  test("schedules multiple contracts fairly by block height", async () => {
    const contractA = "SP123.token-a";
    const contractB = "SP456.token-b";

    registerTxs(
      {
        txId: "tx-a-init",
        blockHeight: 100,
        blockHash: "block-a-init",
        contractId: contractA,
        includeEvent: true,
      },
      { txId: "tx-a-1", blockHeight: 100, blockHash: "block-a-1" },
      { txId: "tx-a-2", blockHeight: 200, blockHash: "block-a-2" },
      {
        txId: "tx-b-init",
        blockHeight: 50,
        blockHash: "block-b-init",
        contractId: contractB,
        includeEvent: true,
      },
      { txId: "tx-b-1", blockHeight: 50, blockHash: "block-b-1" },
      { txId: "tx-b-2", blockHeight: 150, blockHash: "block-b-2" },
    );

    const logEvent = (txId: string, cid: string) => ({
      tx_id: txId,
      event_index: 0,
      event_type: "smart_contract_log",
      contract_log: { contract_id: cid, topic: "print", value: { hex: "", repr: "" } },
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
      const txRoute = handleTxRoutes(url);
      if (txRoute) {
        return txRoute as any;
      }

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

      // Contract A pages
      if (
        url.includes(`/extended/v2/smart-contracts/${contractA}/logs?limit=100&cursor=100:0:0:0`)
      ) {
        return makeLogsResponse([logEvent("tx-a-1", contractA)], "200:0:0:0");
      }
      if (
        url.includes(`/extended/v2/smart-contracts/${contractA}/logs?limit=100&cursor=200:0:0:0`)
      ) {
        return makeLogsResponse([logEvent("tx-a-2", contractA)], null);
      }

      // Contract B pages
      if (
        url.includes(`/extended/v2/smart-contracts/${contractB}/logs?limit=100&cursor=50:0:0:0`)
      ) {
        return makeLogsResponse([logEvent("tx-b-1", contractB)], "150:0:0:0");
      }
      if (
        url.includes(`/extended/v2/smart-contracts/${contractB}/logs?limit=100&cursor=150:0:0:0`)
      ) {
        return makeLogsResponse([logEvent("tx-b-2", contractB)], null);
      }

      // Blocks
      if (url.includes("/extended/v2/blocks/block-a-1")) {
        return makeBlockResponse(100, "block-a-1");
      }
      if (url.includes("/extended/v2/blocks/block-a-2")) {
        return makeBlockResponse(200, "block-a-2");
      }
      if (url.includes("/extended/v2/blocks/block-a-init")) {
        return makeBlockResponse(100, "block-a-init");
      }
      if (url.includes("/extended/v2/blocks/block-b-1")) {
        return makeBlockResponse(50, "block-b-1");
      }
      if (url.includes("/extended/v2/blocks/block-b-2")) {
        return makeBlockResponse(150, "block-b-2");
      }
      if (url.includes("/extended/v2/blocks/block-b-init")) {
        return makeBlockResponse(50, "block-b-init");
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
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

    registerTxs({ txId: "tx-1", blockHeight: 100, blockHash: "block-1" });

    // Pre-seed sync progress
    await syncStore.upsertSyncProgress(
      { contractId, chainId: 1, cursor: "100:0:0:0", lastBlockHeight: 100 },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((url: string) => {
      const multiple = handleTxMultiple(url);
      if (multiple) {
        return multiple as any;
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
        return makeBlockResponse(100, "block-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isOk()).toBe(true);

    // Should not have called getAddressTransactions (first cursor discovery)
    const addressTxCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/address/"),
    );
    expect(addressTxCalls).toHaveLength(0);

    // Blocks should be stored
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
      blockTime: 1000n,
      tenureHeight: 100n,
    });

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

    // Events whose transaction is already stored must still resolve valid
    // Heights (from the stored rows) so they are dispatched.
    const seenHeights: number[] = [];
    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([
      {
        contractId,
        handler: (event) => {
          seenHeights.push(event.block_height);
          return Promise.resolve();
        },
      },
    ]);

    expect(result.isOk()).toBe(true);
    expect(seenHeights).toStrictEqual([100]);

    // Verify no getTransactions or getBlockByHash calls were made
    const txCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/extended/v1/tx/"),
    );
    const blockCalls = mockRequest.mock.calls.filter((call: any) =>
      (call[0] as string).includes("/extended/v2/blocks/"),
    );
    expect(txCalls).toHaveLength(0);
    expect(blockCalls).toHaveLength(0);
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
      if (url.includes("/extended/v1/tx/tx-1") && !url.includes("multiple")) {
        return {
          statusCode: 200,
          body: mockBody(
            makeTxApiResponse({
              txId: "tx-1",
              blockHeight: 100,
              blockHash: "block-1",
              contractId,
              includeEvent: true,
            }),
          ),
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

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

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

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler: noopHandler }]);

    expect(result.isOk()).toBe(true);

    // Nothing should be stored
    const blocks = await testDb.db.select().from(blocksTable);
    expect(blocks).toHaveLength(0);
  });

  test("skips non-smart_contract_log events without crashing", async () => {
    const contractId = "SP123.token";

    mockRequest.mockImplementation((url: string) => {
      const multiple = handleTxMultiple(url);
      if (multiple) {
        return multiple as any;
      }
      if (url.includes(`/extended/v1/address/${contractId}/transactions?limit=1`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 1,
            offset: 0,
            total: 1,
            results: [{ tx_id: "tx-1", event_count: 2 }],
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
            results: [{ tx_id: "tx-1", event_count: 2 }],
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            ...makeTxApiResponse({ txId: "tx-1", blockHeight: 100, blockHash: "block-1" }),
            event_count: 2,
            events: [
              { event_index: 0, event_type: "stx_asset" },
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
        return makeBlockResponse(100, "block-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
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

  test("stores raw rows above endBlock but never dispatches them", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockResolvedValue(undefined);

    registerTxs(
      { txId: "tx-1", blockHeight: 100, blockHash: "block-1" },
      { txId: "tx-2", blockHeight: 150, blockHash: "block-2" },
    );

    mockRequest.mockImplementation((url: string) => {
      const multiple = handleTxMultiple(url);
      if (multiple) {
        return multiple as any;
      }
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
          body: mockBody(
            makeTxApiResponse({
              txId: "tx-1",
              blockHeight: 100,
              blockHash: "block-1",
              contractId,
              includeEvent: true,
            }),
          ),
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
            next_cursor: "150:0:0:0",
            prev_cursor: null,
          }),
        };
      }
      // This page starts above the end block; the runtime must stop before fetching it.
      if (
        url.includes(`/extended/v2/smart-contracts/${contractId}/logs?limit=100&cursor=150:0:0:0`)
      ) {
        throw new Error("Should not fetch beyond end block");
      }
      if (url.includes("/extended/v2/blocks/block-1")) {
        return makeBlockResponse(100, "block-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, endBlock: 120 }]);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].block_height).toBe(100);

    // Checkpoint stops at the end block boundary
    const checkpoint = await syncStore.getCheckpoint({ chainId: 1 }, { db: testDb.db });
    expect(Number(checkpoint?.blockHeight)).toBe(100);
  });

  test("does not dispatch events below startBlock while still storing them", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockResolvedValue(undefined);

    registerTxs({ txId: "tx-1", blockHeight: 100, blockHash: "block-1" });

    // Resume from a saved cursor so discovery is skipped.
    await syncStore.upsertSyncProgress(
      { contractId, chainId: 1, cursor: "100:0:0:0", lastBlockHeight: 100 },
      { db: testDb.db },
    );

    mockRequest.mockImplementation((url: string) => {
      const multiple = handleTxMultiple(url);
      if (multiple) {
        return multiple as any;
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
        return makeBlockResponse(100, "block-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler, startBlock: 150 }]);

    expect(result.isOk()).toBe(true);

    // Event was stored in the sync store...
    const storedEvents = await testDb.db.select().from(eventsTable);
    expect(storedEvents).toHaveLength(1);

    // ...but never dispatched to the handler.
    expect(handler).not.toHaveBeenCalled();

    // Checkpoint still advances past the skipped range.
    const checkpoint = await syncStore.getCheckpoint({ chainId: 1 }, { db: testDb.db });
    expect(Number(checkpoint?.blockHeight)).toBe(100);
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
    expect(() => parseCursor("100:0:five:2")).toThrow("Invalid cursor format: 100:0:five:2");
    expect(() => parseCursor("100:0:5:2.5")).toThrow("Invalid cursor format: 100:0:5:2.5");
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
    txRegistry.clear();
    await testDb.cleanup();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await testDb.close();
  });

  function setupTwoContractScenario() {
    const contractA = "SP123.token-a";
    const contractB = "SP456.token-b";

    registerTxs(
      {
        txId: "tx-a-init",
        blockHeight: 100,
        blockHash: "block-a-init",
        contractId: contractA,
        includeEvent: true,
      },
      { txId: "tx-a-1", blockHeight: 100, blockHash: "block-a-1" },
      {
        txId: "tx-b-init",
        blockHeight: 50,
        blockHash: "block-b-init",
        contractId: contractB,
        includeEvent: true,
      },
      { txId: "tx-b-1", blockHeight: 50, blockHash: "block-b-1" },
    );

    const logEvent = (txId: string, cid: string) => ({
      tx_id: txId,
      event_index: 0,
      event_type: "smart_contract_log",
      contract_log: { contract_id: cid, topic: "print", value: { hex: "", repr: "" } },
    });

    mockRequest.mockImplementation((url: string) => {
      const txRoute = handleTxRoutes(url);
      if (txRoute) {
        return txRoute as any;
      }
      if (url.includes(`/extended/v1/address/${contractA}/transactions`)) {
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
      if (url.includes(`/extended/v1/address/${contractB}/transactions`)) {
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
      if (url.includes(`/extended/v2/smart-contracts/${contractA}/logs`)) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [logEvent("tx-a-1", contractA)],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }
      if (url.includes(`/extended/v2/smart-contracts/${contractB}/logs`)) {
        return {
          statusCode: 200,
          body: mockBody({
            results: [logEvent("tx-b-1", contractB)],
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }
      if (url.includes("/extended/v2/blocks/block-a-init")) {
        return makeBlockResponse(100, "block-a-init");
      }
      if (url.includes("/extended/v2/blocks/block-a-1")) {
        return makeBlockResponse(100, "block-a-1");
      }
      if (url.includes("/extended/v2/blocks/block-b-init")) {
        return makeBlockResponse(50, "block-b-init");
      }
      if (url.includes("/extended/v2/blocks/block-b-1")) {
        return makeBlockResponse(50, "block-b-1");
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    return { contractA, contractB };
  }

  test("calls handlers in global chronological order across contracts", async () => {
    const { contractA, contractB } = setupTwoContractScenario();
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
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

  test("passes decoded Clarity values and a read-only client to handlers", async () => {
    const contractId = "SP123.token";
    const received: HandlerEvent[] = [];
    const callReadUrls: string[] = [];

    registerTxs({
      txId: "tx-1",
      blockHeight: 100,
      blockHash: "block-1",
      contractId,
      includeEvent: true,
    });

    mockRequest.mockImplementation((url: string) => {
      const txRoute = handleTxRoutes(url);
      if (txRoute) {
        return txRoute as any;
      }
      if (url.includes(`/extended/v1/address/${contractId}/transactions`)) {
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
                  value: { hex: "0x0100000000000000000000000000000005", repr: "u5" },
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
      if (url.includes("/v2/contracts/call-read/")) {
        callReadUrls.push(url);
        return {
          statusCode: 200,
          body: mockBody({ okay: true, result: "0x03" }),
        };
      }
      if (url.includes("/extended/v2/blocks/block-1")) {
        return makeBlockResponse(100, "block-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([
      {
        contractId,
        handler: async (event, context) => {
          received.push(event);
          const call = await context.client.callReadOnly(contractId, "get-pool-count");
          expect(call.isOk()).toBe(true);
          expect(call.isOk() && call.value.okay).toBe(true);
        },
      },
    ]);

    expect(result.isOk()).toBe(true);
    expect(received).toHaveLength(1);
    expect(received[0].decoded).toMatchObject({ type: ClarityType.UInt, value: 5n });

    // Read-only calls must be pinned to the tip of the block being processed.
    expect(callReadUrls).toHaveLength(1);
    expect(callReadUrls[0]).toContain("/v2/contracts/call-read/SP123/token/get-pool-count?tip=100");
    expect(callReadUrls[0]).toContain("tip=100");
  });

  test("updates checkpoint after processing events", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockResolvedValue(undefined);

    registerTxs({
      txId: "tx-1",
      blockHeight: 100,
      blockHash: "block-1",
      contractId,
      includeEvent: true,
    });

    mockRequest.mockImplementation((url: string) => {
      const txRoute = handleTxRoutes(url);
      if (txRoute) {
        return txRoute as any;
      }
      if (url.includes(`/extended/v1/address/${contractId}/transactions`)) {
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
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }
      if (url.includes("/extended/v2/blocks/block-1")) {
        return makeBlockResponse(100, "block-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
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

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result.isOk()).toBe(true);
    // Handler should NOT be called because the event is at block 100 which is already checkpointed
    expect(handler).not.toHaveBeenCalled();
  });

  test("returns error when handler throws", async () => {
    const contractId = "SP123.token";
    const handler = vi.fn().mockRejectedValue(new Error("Handler failed"));

    registerTxs({
      txId: "tx-1",
      blockHeight: 100,
      blockHash: "block-1",
      contractId,
      includeEvent: true,
    });

    mockRequest.mockImplementation((url: string) => {
      const txRoute = handleTxRoutes(url);
      if (txRoute) {
        return txRoute as any;
      }
      if (url.includes(`/extended/v1/address/${contractId}/transactions`)) {
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
            limit: 100,
            offset: 0,
            total: 1,
            next_cursor: null,
            prev_cursor: null,
          }),
        };
      }
      if (url.includes("/extended/v2/blocks/block-1")) {
        return makeBlockResponse(100, "block-1");
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const runtime = createHistoricalRuntime({ logger, db: testDb.db });
    const result = await runtime.run([{ contractId, handler }]);

    expect(result.isErr()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
