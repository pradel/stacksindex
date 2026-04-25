// oxlint-disable max-lines

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { syncStore } from "./index.ts";
import {
  blocksTable,
  checkpointsTable,
  eventsTable,
  syncProgressTable,
  transactionsTable,
} from "./schema.ts";

const block = {
  canonical: true,
  height: 7443118,
  hash: "0xa7a68bdbb6048b0b614733c9c49410956a8df3e6bc6b55b336a4020b8d6770ee",
  block_time: 1775126085,
  block_time_iso: "2026-04-02T10:34:45.000Z",
  tenure_height: 237303,
  index_block_hash: "0x9ff38d3c314e8b60fa2c1e556339b7c4e650bb134f52e262b67112ba32ca302c",
  parent_block_hash: "0xd2a89219fe4676c97115171852d01f6fa58df43a3d94822815b484cf5e9ead7c",
  parent_index_block_hash: "0x39c2e63268fb24e9b25accbfe4e27991a13464ac16bc116531ff675b59421363",
  burn_block_time: 1775125322,
  burn_block_time_iso: "2026-04-02T10:22:02.000Z",
  burn_block_hash: "0x00000000000000000001d258be65762027ed100f10b168106c9aa03406b92695",
  burn_block_height: 943342,
  miner_txid: "0x8a6391fdc9814243b5d27ebe0080f6265364d03203fcf558a126f846cc0dba19",
  tx_count: 1,
  execution_cost_read_count: 0,
  execution_cost_read_length: 0,
  execution_cost_runtime: 0,
  execution_cost_write_count: 0,
  execution_cost_write_length: 0,
};

const transaction = {
  tx_id: "0x78323ef7a23b45b96f318f5e41306dee91ee1d083b0e98be75382b91cab88f80",
  nonce: 43334,
  fee_rate: "1218",
  sender_address: "SP220K5EDGPF1A09AD0VCTGC541TJH4SX96DV5ES7",
  sponsored: false,
  post_condition_mode: "deny",
  post_conditions: [],
  anchor_mode: "any",
  block_hash: "0xaa832f80b70e93f9b35415cf88b00daf6c398997520ad1efc00d83afd1157c81",
  block_height: 7444092,
  block_time: 1775137130,
  block_time_iso: "2026-04-02T13:38:50.000Z",
  burn_block_time: 1775137333,
  burn_block_height: 943364,
  burn_block_time_iso: "2026-04-02T13:42:13.000Z",
  parent_burn_block_time: 1775137333,
  parent_burn_block_time_iso: "2026-04-02T13:42:13.000Z",
  canonical: true,
  tx_index: 3,
  tx_status: "success",
  tx_result: {
    hex: "0x0703",
    repr: "(ok true)",
  },
  event_count: 1,
  parent_block_hash: "0x5594d5355a70d798871bc202ba2b843291ec032ff2367616bc539291f47abf32",
  is_unanchored: false,
  microblock_hash: "0x",
  microblock_sequence: 2147483647,
  microblock_canonical: true,
  execution_cost_read_count: 0,
  execution_cost_read_length: 0,
  execution_cost_runtime: 0,
  execution_cost_write_count: 0,
  execution_cost_write_length: 0,
  vm_error: null,
  events: [],
  tx_type: "token_transfer",
  token_transfer: {
    recipient_address: "SP2728B2NG5E4P60KH8Y8D65298XS7TYD0306RFSX",
    amount: "2218",
    memo: "0x31303036383334300000000000000000000000000000000000000000000000000000",
  },
};

// oxlint-disable-next-line vitest/prefer-describe-function-title
describe("syncStore", () => {
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

  describe("insertBlocks", () => {
    test("insert blocks", async () => {
      await syncStore.insertBlocks(
        {
          blocks: [block],
        },
        { db: testDb.db },
      );

      const result = await testDb.db.select().from(blocksTable);
      expect(result).toStrictEqual([
        {
          blockTime: 1775125322n,
          chainId: 1n,
          hash: "0xa7a68bdbb6048b0b614733c9c49410956a8df3e6bc6b55b336a4020b8d6770ee",
          height: 7443118n,
          tenureHeight: 943342n,
        },
      ]);
    });
  });

  describe("insertTransactions", () => {
    test("insert transactions", async () => {
      await syncStore.insertTransactions(
        {
          transactions: [transaction],
        },
        { db: testDb.db },
      );

      const result = await testDb.db.select().from(transactionsTable);
      expect(result).toStrictEqual([
        {
          blockHash: "0xaa832f80b70e93f9b35415cf88b00daf6c398997520ad1efc00d83afd1157c81",
          blockHeight: 7444092n,
          canonical: true,
          chainId: 1n,
          feeRate: 1218n,
          nonce: 43334n,
          senderAddress: "SP220K5EDGPF1A09AD0VCTGC541TJH4SX96DV5ES7",
          txId: "0x78323ef7a23b45b96f318f5e41306dee91ee1d083b0e98be75382b91cab88f80",
          txIndex: 3,
          txStatus: "success",
          txType: "token_transfer",
        },
      ]);
    });
  });

  describe("getSyncProgress", () => {
    test("returns null when no progress exists", async () => {
      const result = await syncStore.getSyncProgress(
        { contractId: "SP123.token", chainId: 1 },
        { db: testDb.db },
      );
      expect(result).toBeNull();
    });

    test("returns saved progress", async () => {
      await testDb.db.insert(syncProgressTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        cursor: "100:0:5:2",
        lastBlockHeight: 100n,
      });

      const result = await syncStore.getSyncProgress(
        { contractId: "SP123.token", chainId: 1 },
        { db: testDb.db },
      );
      expect(result).toStrictEqual({
        chainId: 1n,
        contractId: "SP123.token",
        cursor: "100:0:5:2",
        lastBlockHeight: 100n,
      });
    });
  });

  describe("upsertSyncProgress", () => {
    test("inserts new progress", async () => {
      await syncStore.upsertSyncProgress(
        { contractId: "SP123.token", chainId: 1, cursor: "200:0:3:1", lastBlockHeight: 200 },
        { db: testDb.db },
      );

      const result = await testDb.db.select().from(syncProgressTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          contractId: "SP123.token",
          cursor: "200:0:3:1",
          lastBlockHeight: 200n,
        },
      ]);
    });

    test("updates existing progress", async () => {
      await testDb.db.insert(syncProgressTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        cursor: "100:0:5:2",
        lastBlockHeight: 100n,
      });

      await syncStore.upsertSyncProgress(
        { contractId: "SP123.token", chainId: 1, cursor: "300:0:1:0", lastBlockHeight: 300 },
        { db: testDb.db },
      );

      const result = await testDb.db.select().from(syncProgressTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          contractId: "SP123.token",
          cursor: "300:0:1:0",
          lastBlockHeight: 300n,
        },
      ]);
    });
  });

  describe("getExistingTransactions", () => {
    test("returns empty array when no transactions exist", async () => {
      const result = await syncStore.getExistingTransactions(
        { txIds: ["tx-1", "tx-2"], chainId: 1 },
        { db: testDb.db },
      );
      expect(result).toStrictEqual([]);
    });

    test("returns only existing transaction ids", async () => {
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

      const result = await syncStore.getExistingTransactions(
        { txIds: ["tx-1", "tx-2"], chainId: 1 },
        { db: testDb.db },
      );
      expect(result).toStrictEqual(["tx-1"]);
    });
  });

  describe("getExistingBlocks", () => {
    test("returns empty array when no blocks exist", async () => {
      const result = await syncStore.getExistingBlocks(
        { blockHashes: ["block-1", "block-2"], chainId: 1 },
        { db: testDb.db },
      );
      expect(result).toStrictEqual([]);
    });

    test("returns only existing block hashes", async () => {
      await testDb.db.insert(blocksTable).values({
        chainId: 1n,
        height: 100n,
        hash: "block-1",
        blockTime: 1n,
        tenureHeight: 1n,
      });

      const result = await syncStore.getExistingBlocks(
        { blockHashes: ["block-1", "block-2"], chainId: 1 },
        { db: testDb.db },
      );
      expect(result).toStrictEqual(["block-1"]);
    });
  });

  describe("insertEvents", () => {
    test("inserts events", async () => {
      await syncStore.insertEvents(
        {
          events: [
            {
              event: {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log",
                contract_id: "SP123.token",
                topic: "print",
                value: { hex: "0x01", repr: "(ok true)" },
              },
              blockHeight: 100,
            },
          ],
        },
        { db: testDb.db },
      );

      const result = await testDb.db.select().from(eventsTable);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        txId: "tx-1",
        contractId: "SP123.token",
        eventType: "smart_contract_log",
        valueHex: "0x01",
        valueRepr: "(ok true)",
      });
      expect(Number(result[0].blockHeight)).toBe(100);
    });

    test("ignores duplicate events", async () => {
      const event = {
        tx_id: "tx-1",
        event_index: 0,
        event_type: "smart_contract_log",
        contract_id: "SP123.token",
        topic: "print",
        value: { hex: "0x01", repr: "(ok true)" },
      };

      await syncStore.insertEvents({ events: [{ event, blockHeight: 100 }] }, { db: testDb.db });
      await syncStore.insertEvents({ events: [{ event, blockHeight: 100 }] }, { db: testDb.db });

      const result = await testDb.db.select().from(eventsTable);
      expect(result).toHaveLength(1);
    });
  });

  describe("getEvents", () => {
    test("returns events ordered by block height, tx index, event index", async () => {
      // Seed blocks and transactions
      await testDb.db.insert(blocksTable).values({
        chainId: 1n,
        height: 100n,
        hash: "block-100",
        blockTime: 1000n,
        tenureHeight: 100n,
      });
      await testDb.db.insert(blocksTable).values({
        chainId: 1n,
        height: 200n,
        hash: "block-200",
        blockTime: 2000n,
        tenureHeight: 200n,
      });
      await testDb.db.insert(transactionsTable).values({
        chainId: 1n,
        txId: "tx-1",
        blockHeight: 100n,
        blockHash: "block-100",
        txIndex: 1,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
        canonical: true,
      });
      await testDb.db.insert(transactionsTable).values({
        chainId: 1n,
        txId: "tx-2",
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
      await testDb.db.insert(transactionsTable).values({
        chainId: 1n,
        txId: "tx-3",
        blockHeight: 200n,
        blockHash: "block-200",
        txIndex: 0,
        txType: "contract_call",
        senderAddress: "SP sender",
        feeRate: 1000n,
        nonce: 0n,
        txStatus: "success",
        canonical: true,
      });

      // Seed events out of order
      await testDb.db.insert(eventsTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        txId: "tx-1",
        eventIndex: 0,
        eventType: "smart_contract_log",
        topic: "print",
        valueHex: "0x01",
        valueRepr: "(ok true)",
        blockHeight: 100n,
      });
      await testDb.db.insert(eventsTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        txId: "tx-3",
        eventIndex: 0,
        eventType: "smart_contract_log",
        topic: "print",
        valueHex: "0x02",
        valueRepr: "(ok false)",
        blockHeight: 200n,
      });
      await testDb.db.insert(eventsTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        txId: "tx-2",
        eventIndex: 0,
        eventType: "smart_contract_log",
        topic: "print",
        valueHex: "0x03",
        valueRepr: "(ok 1)",
        blockHeight: 100n,
      });

      const result = await syncStore.getEvents(
        { chainId: 1, fromBlockHeight: 0, toBlockHeight: 9999 },
        { db: testDb.db },
      );

      expect(result).toHaveLength(3);
      // Should be ordered by blockHeight, txIndex, eventIndex
      // Block 100, txIndex 0
      expect(result[0].txId).toBe("tx-2");
      // Block 100, txIndex 1
      expect(result[1].txId).toBe("tx-1");
      // Block 200, txIndex 0
      expect(result[2].txId).toBe("tx-3");
    });

    test("filters by block height range", async () => {
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
      await testDb.db.insert(eventsTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        txId: "tx-1",
        eventIndex: 0,
        eventType: "smart_contract_log",
        topic: "print",
        valueHex: "0x01",
        valueRepr: "(ok true)",
        blockHeight: 100n,
      });

      const result = await syncStore.getEvents(
        { chainId: 1, fromBlockHeight: 200, toBlockHeight: 300 },
        { db: testDb.db },
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("getCheckpoint", () => {
    test("returns null when no checkpoint exists", async () => {
      const result = await syncStore.getCheckpoint({ chainId: 1 }, { db: testDb.db });
      expect(result).toBeNull();
    });

    test("returns saved checkpoint", async () => {
      await testDb.db.insert(checkpointsTable).values({
        chainId: 1n,
        blockHeight: 100n,
        blockTime: 1000n,
      });

      const result = await syncStore.getCheckpoint({ chainId: 1 }, { db: testDb.db });
      expect(result).toStrictEqual({
        chainId: 1n,
        blockHeight: 100n,
        blockTime: 1000n,
      });
    });
  });

  describe("upsertCheckpoint", () => {
    test("inserts new checkpoint", async () => {
      await syncStore.upsertCheckpoint(
        { chainId: 1, blockHeight: 100, blockTime: 1000 },
        { db: testDb.db },
      );

      const result = await testDb.db.select().from(checkpointsTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          blockHeight: 100n,
          blockTime: 1000n,
        },
      ]);
    });

    test("updates existing checkpoint", async () => {
      await testDb.db.insert(checkpointsTable).values({
        chainId: 1n,
        blockHeight: 100n,
        blockTime: 1000n,
      });

      await syncStore.upsertCheckpoint(
        { chainId: 1, blockHeight: 200, blockTime: 2000 },
        { db: testDb.db },
      );

      const result = await testDb.db.select().from(checkpointsTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          blockHeight: 200n,
          blockTime: 2000n,
        },
      ]);
    });
  });
});
