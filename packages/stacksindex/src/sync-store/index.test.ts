import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import type { SmartContractLogEvent, StorableTransaction } from "../datasources/api/index.ts";
import { SyncStoreError } from "../lib/errors.ts";
import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { syncStore } from "./index.ts";
import {
  blocksTable,
  checkpointsTable,
  eventsTable,
  syncProgressTable,
  transactionsTable,
} from "./schema.ts";

const blockRow = (height: number, chainId = 1n) => ({
  chainId,
  height: BigInt(height),
  hash: `block-${height}`,
  indexBlockHash: `index-block-${height}`,
  blockTime: BigInt(height * 10),
  tenureHeight: BigInt(height),
});

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

const transaction: StorableTransaction = {
  tx_id: "0x78323ef7a23b45b96f318f5e41306dee91ee1d083b0e98be75382b91cab88f80",
  fee_rate: "1218",
  sender: {
    address: "SP220K5EDGPF1A09AD0VCTGC541TJH4SX96DV5ES7",
    nonce: 43334,
  },
  block: {
    hash: "0xaa832f80b70e93f9b35415cf88b00daf6c398997520ad1efc00d83afd1157c81",
    height: 7444092,
    time: 1775137130,
    tx_index: 3,
    index_hash: "0x9ff38d3c314e8b60fa2c1e556339b7c4e650bb134f52e262b67112ba32ca302c",
  },
  bitcoin_block: {
    height: 943364,
    time: 1775137333,
  },
  status: "success",
  type: "token_transfer",
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
      await testDb.run(
        syncStore.insertBlocks({
          blocks: [block],
          chainId: 1,
        }),
      );

      const result = await testDb.db.select().from(blocksTable);
      expect(result).toStrictEqual([
        {
          blockTime: 1775125322n,
          chainId: 1n,
          hash: "0xa7a68bdbb6048b0b614733c9c49410956a8df3e6bc6b55b336a4020b8d6770ee",
          height: 7443118n,
          indexBlockHash: "0x9ff38d3c314e8b60fa2c1e556339b7c4e650bb134f52e262b67112ba32ca302c",
          tenureHeight: 943342n,
        },
      ]);
    });

    test("insert blocks with custom chainId", async () => {
      await testDb.run(
        syncStore.insertBlocks({
          blocks: [block],
          chainId: 2147483648,
        }),
      );

      const result = await testDb.db.select().from(blocksTable);
      expect(result).toStrictEqual([
        {
          blockTime: 1775125322n,
          chainId: 2147483648n,
          hash: "0xa7a68bdbb6048b0b614733c9c49410956a8df3e6bc6b55b336a4020b8d6770ee",
          height: 7443118n,
          indexBlockHash: "0x9ff38d3c314e8b60fa2c1e556339b7c4e650bb134f52e262b67112ba32ca302c",
          tenureHeight: 943342n,
        },
      ]);
    });
  });

  describe("insertTransactions", () => {
    test("insert transactions", async () => {
      await testDb.run(
        syncStore.insertTransactions({
          transactions: [transaction],
          chainId: 1,
        }),
      );

      const result = await testDb.db.select().from(transactionsTable);
      expect(result).toStrictEqual([
        {
          blockHash: "0xaa832f80b70e93f9b35415cf88b00daf6c398997520ad1efc00d83afd1157c81",
          blockHeight: 7444092n,
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

    test("insert transactions with custom chainId", async () => {
      await testDb.run(
        syncStore.insertTransactions({
          transactions: [transaction],
          chainId: 2147483648,
        }),
      );

      const result = await testDb.db.select().from(transactionsTable);
      expect(result).toStrictEqual([
        {
          blockHash: "0xaa832f80b70e93f9b35415cf88b00daf6c398997520ad1efc00d83afd1157c81",
          blockHeight: 7444092n,
          chainId: 2147483648n,
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
      const result = await testDb.run(
        syncStore.getSyncProgress({ contractId: "SP123.token", chainId: 1 }),
      );

      expect(result).toBeNull();
    });

    test("returns saved progress", async () => {
      await testDb.db.insert(syncProgressTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        cursor: "100:0:5:2",
        syncedBlockHeight: 100n,
      });

      const result = await testDb.run(
        syncStore.getSyncProgress({ contractId: "SP123.token", chainId: 1 }),
      );

      expect(result).toStrictEqual({
        chainId: 1n,
        contractId: "SP123.token",
        cursor: "100:0:5:2",
        syncedBlockHeight: 100n,
        isComplete: false,
      });
    });
  });

  describe("upsertSyncProgress", () => {
    test("inserts new progress", async () => {
      await testDb.run(
        syncStore.upsertSyncProgress({
          contractId: "SP123.token",
          chainId: 1,
          cursor: "200:0:3:1",
          syncedBlockHeight: 200,
        }),
      );

      const result = await testDb.db.select().from(syncProgressTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          contractId: "SP123.token",
          cursor: "200:0:3:1",
          syncedBlockHeight: 200n,
          isComplete: false,
        },
      ]);
    });

    test("updates existing progress", async () => {
      await testDb.db.insert(syncProgressTable).values({
        chainId: 1n,
        contractId: "SP123.token",
        cursor: "100:0:5:2",
        syncedBlockHeight: 100n,
      });

      await testDb.run(
        syncStore.upsertSyncProgress({
          contractId: "SP123.token",
          chainId: 1,
          cursor: "300:0:1:0",
          syncedBlockHeight: 300,
        }),
      );

      const result = await testDb.db.select().from(syncProgressTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          contractId: "SP123.token",
          cursor: "300:0:1:0",
          syncedBlockHeight: 300n,
          isComplete: false,
        },
      ]);
    });

    test("saves completed status with null cursor", async () => {
      await testDb.run(
        syncStore.upsertSyncProgress({
          contractId: "SP123.token",
          chainId: 1,
          cursor: null,
          syncedBlockHeight: 500,
          isComplete: true,
        }),
      );

      const result = await testDb.db.select().from(syncProgressTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          contractId: "SP123.token",
          cursor: null,
          syncedBlockHeight: 500n,
          isComplete: true,
        },
      ]);
    });
  });

  describe("getExistingTransactions", () => {
    test("returns empty array when no transactions exist", async () => {
      const result = await testDb.run(
        syncStore.getExistingTransactions({ txIds: ["tx-1", "tx-2"], chainId: 1 }),
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
      });

      const result = await testDb.run(
        syncStore.getExistingTransactions({ txIds: ["tx-1", "tx-2"], chainId: 1 }),
      );

      expect(result).toStrictEqual([{ txId: "tx-1", blockHeight: 100n }]);
    });
  });

  describe("getExistingBlocks", () => {
    test("returns empty array when no blocks exist", async () => {
      const result = await testDb.run(
        syncStore.getExistingBlocks({ blockHashes: ["block-1", "block-2"], chainId: 1 }),
      );

      expect(result).toStrictEqual([]);
    });

    test("returns only existing block hashes", async () => {
      await testDb.db.insert(blocksTable).values({
        chainId: 1n,
        height: 100n,
        hash: "block-1",
        indexBlockHash: "index-block-1",
        blockTime: 1n,
        tenureHeight: 1n,
      });

      const result = await testDb.run(
        syncStore.getExistingBlocks({ blockHashes: ["block-1", "block-2"], chainId: 1 }),
      );

      expect(result).toStrictEqual(["block-1"]);
    });
  });

  describe("insertEvents", () => {
    test("inserts events", async () => {
      await testDb.run(
        syncStore.insertEvents({
          events: [
            {
              event: {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log" as const,
                contract_log: {
                  contract_id: "SP123.token",
                  topic: "print",
                  value: { hex: "0x01", repr: "(ok true)" },
                },
              } satisfies SmartContractLogEvent,
              blockHeight: 100,
            },
          ],
          chainId: 1,
        }),
      );

      const result = await testDb.db.select().from(eventsTable);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        chainId: 1n,
        txId: "tx-1",
        contractId: "SP123.token",
        eventType: "smart_contract_log",
        valueHex: "0x01",
        valueRepr: "(ok true)",
      });
      expect(Number(result[0].blockHeight)).toBe(100);
    });

    test("inserts events with custom chainId", async () => {
      await testDb.run(
        syncStore.insertEvents({
          events: [
            {
              event: {
                tx_id: "tx-1",
                event_index: 0,
                event_type: "smart_contract_log" as const,
                contract_log: {
                  contract_id: "SP123.token",
                  topic: "print",
                  value: { hex: "0x01", repr: "(ok true)" },
                },
              } satisfies SmartContractLogEvent,
              blockHeight: 100,
            },
          ],
          chainId: 2147483648,
        }),
      );

      const result = await testDb.db.select().from(eventsTable);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        chainId: 2147483648n,
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
        event_type: "smart_contract_log" as const,
        contract_log: {
          contract_id: "SP123.token",
          topic: "print",
          value: { hex: "0x01", repr: "(ok true)" },
        },
      } satisfies SmartContractLogEvent;

      await testDb.run(
        syncStore.insertEvents({ events: [{ event, blockHeight: 100 }], chainId: 1 }),
      );
      await testDb.run(
        syncStore.insertEvents({ events: [{ event, blockHeight: 100 }], chainId: 1 }),
      );

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
        indexBlockHash: "index-block-100",
        blockTime: 1000n,
        tenureHeight: 100n,
      });
      await testDb.db.insert(blocksTable).values({
        chainId: 1n,
        height: 200n,
        hash: "block-200",
        indexBlockHash: "index-block-200",
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

      const result = await testDb.run(
        syncStore.getEvents({ chainId: 1, fromBlockHeight: 0, toBlockHeight: 9999 }),
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
        indexBlockHash: "index-block-100",
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

      const result = await testDb.run(
        syncStore.getEvents({ chainId: 1, fromBlockHeight: 200, toBlockHeight: 300 }),
      );

      expect(result).toHaveLength(0);
    });
  });

  describe("getCheckpoint", () => {
    test("returns null when no checkpoint exists", async () => {
      const result = await testDb.run(syncStore.getCheckpoint({ chainId: 1 }));
      expect(result).toBeNull();
    });

    test("returns saved checkpoint", async () => {
      await testDb.db.insert(checkpointsTable).values({
        chainId: 1n,
        blockHeight: 100n,
        blockTime: 1000n,
        finalizedBlockHeight: 90n,
        finalizedBlockTime: 900n,
      });

      const result = await testDb.run(syncStore.getCheckpoint({ chainId: 1 }));
      expect(result).toStrictEqual({
        chainId: 1n,
        blockHeight: 100n,
        blockTime: 1000n,
        finalizedBlockHeight: 90n,
        finalizedBlockTime: 900n,
      });
    });
  });

  describe("upsertCheckpoint", () => {
    test("inserts new checkpoint", async () => {
      await testDb.run(
        syncStore.upsertCheckpoint({
          chainId: 1,
          blockHeight: 100,
          blockTime: 1000,
          finalizedBlockHeight: 90,
          finalizedBlockTime: 900,
        }),
      );

      const result = await testDb.db.select().from(checkpointsTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          blockHeight: 100n,
          blockTime: 1000n,
          finalizedBlockHeight: 90n,
          finalizedBlockTime: 900n,
        },
      ]);
    });

    test("updates existing checkpoint", async () => {
      await testDb.db.insert(checkpointsTable).values({
        chainId: 1n,
        blockHeight: 100n,
        blockTime: 1000n,
        finalizedBlockHeight: 90n,
        finalizedBlockTime: 900n,
      });

      await testDb.run(
        syncStore.upsertCheckpoint({
          chainId: 1,
          blockHeight: 200,
          blockTime: 2000,
          finalizedBlockHeight: 190,
          finalizedBlockTime: 1900,
        }),
      );

      const result = await testDb.db.select().from(checkpointsTable);
      expect(result).toStrictEqual([
        {
          chainId: 1n,
          blockHeight: 200n,
          blockTime: 2000n,
          finalizedBlockHeight: 190n,
          finalizedBlockTime: 1900n,
        },
      ]);
    });
  });

  describe("rewindTo", () => {
    test("returns null when no checkpoint exists", async () => {
      const result = await testDb.run(syncStore.rewindTo({ chainId: 1, blockHeight: 0 }));

      expect(result).toBeNull();
    });

    test("returns null when the checkpoint is not above the height", async () => {
      await testDb.db.insert(checkpointsTable).values({
        chainId: 1n,
        blockHeight: 200n,
        blockTime: 2000n,
        finalizedBlockHeight: 200n,
        finalizedBlockTime: 2000n,
      });

      const result = await testDb.run(syncStore.rewindTo({ chainId: 1, blockHeight: 200 }));

      expect(result).toBeNull();
    });

    test("discards data above the height and resets affected progress", async () => {
      await testDb.db.insert(blocksTable).values([
        {
          chainId: 1n,
          height: 100n,
          hash: "block-100",
          indexBlockHash: "index-block-100",
          blockTime: 1000n,
          tenureHeight: 100n,
        },
        {
          chainId: 1n,
          height: 200n,
          hash: "block-200",
          indexBlockHash: "index-block-200",
          blockTime: 2000n,
          tenureHeight: 200n,
        },
        {
          chainId: 1n,
          height: 300n,
          hash: "block-300",
          indexBlockHash: "index-block-300",
          blockTime: 3000n,
          tenureHeight: 300n,
        },
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
          feeRate: 1n,
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
          feeRate: 1n,
          nonce: 0n,
          txStatus: "success",
        },
      ]);

      const logEvent = (txId: string) =>
        ({
          tx_id: txId,
          event_index: 0,
          event_type: "smart_contract_log" as const,
          contract_log: {
            contract_id: "SP123.token",
            topic: "print",
            value: { hex: "0x01", repr: "(ok true)" },
          },
        }) satisfies SmartContractLogEvent;

      await testDb.run(
        syncStore.insertEvents({
          events: [
            { event: logEvent("tx-100"), blockHeight: 100 },
            { event: logEvent("tx-300"), blockHeight: 300 },
          ],
          chainId: 1,
        }),
      );

      await testDb.db.insert(syncProgressTable).values([
        {
          chainId: 1n,
          contractId: "SP123.token",
          cursor: "300:0:0:0",
          syncedBlockHeight: 299n,
          isComplete: false,
        },
        {
          chainId: 1n,
          contractId: "SP456.token",
          cursor: "150:0:0:0",
          syncedBlockHeight: 149n,
          isComplete: false,
        },
      ]);

      await testDb.db.insert(checkpointsTable).values({
        chainId: 1n,
        blockHeight: 300n,
        blockTime: 3000n,
        finalizedBlockHeight: 200n,
        finalizedBlockTime: 2000n,
      });

      const result = await testDb.run(syncStore.rewindTo({ chainId: 1, blockHeight: 200 }));

      expect(result).toStrictEqual({ fromBlockHeight: 300, toBlockHeight: 200 });

      const blocks = await testDb.db.select().from(blocksTable);
      expect(blocks.map((row) => Number(row.height))).toStrictEqual([100, 200]);

      const transactions = await testDb.db.select().from(transactionsTable);
      expect(transactions.map((row) => row.txId)).toStrictEqual(["tx-100"]);

      const events = await testDb.db.select().from(eventsTable);
      expect(events.map((row) => row.txId)).toStrictEqual(["tx-100"]);

      const checkpoint = await testDb.db.select().from(checkpointsTable);
      expect(checkpoint).toStrictEqual([
        {
          chainId: 1n,
          blockHeight: 200n,
          blockTime: 2000n,
          finalizedBlockHeight: 200n,
          finalizedBlockTime: 2000n,
        },
      ]);

      const progress = await testDb.db.select().from(syncProgressTable);
      expect(
        progress.sort((left, right) => left.contractId.localeCompare(right.contractId)),
      ).toStrictEqual([
        {
          chainId: 1n,
          contractId: "SP123.token",
          cursor: null,
          syncedBlockHeight: 200n,
          isComplete: false,
        },
        {
          chainId: 1n,
          contractId: "SP456.token",
          cursor: "150:0:0:0",
          syncedBlockHeight: 149n,
          isComplete: false,
        },
      ]);
    });
  });

  describe("block sync progress", () => {
    const upsert = (name: string, syncedBlockHeight: number, isComplete = false, chainId = 1) =>
      testDb.run(
        syncStore.upsertBlockSyncProgress({
          chainId,
          name,
          interval: 10,
          startBlock: 100,
          syncedBlockHeight,
          isComplete,
        }),
      );

    test("returns null for a source without progress", async () => {
      await expect(
        testDb.run(syncStore.getBlockSyncProgress({ chainId: 1, name: "Hourly" })),
      ).resolves.toBeNull();
    });

    test("upserts progress per chain and name", async () => {
      await upsert("Hourly", 99);
      await upsert("Hourly", 150, true);
      await upsert("Daily", 120);
      await upsert("Hourly", 300, false, 2);

      await expect(
        testDb.run(syncStore.getBlockSyncProgress({ chainId: 1, name: "Hourly" })),
      ).resolves.toStrictEqual({
        chainId: 1n,
        name: "Hourly",
        interval: 10n,
        startBlock: 100n,
        syncedBlockHeight: 150n,
        isComplete: true,
      });
      await expect(
        testDb.run(syncStore.listBlockSyncProgress({ chainId: 1 })),
      ).resolves.toMatchObject([
        { name: "Daily", syncedBlockHeight: 120n },
        { name: "Hourly", syncedBlockHeight: 150n },
      ]);
    });

    test("raises only incomplete sources below the height, completing those at endBlock", async () => {
      await upsert("Behind", 100);
      await upsert("EndsAt150", 100);
      await upsert("Ahead", 200);
      await upsert("Done", 120, true);

      await testDb.run(
        syncStore.raiseBlockSyncedBlockHeight({
          chainId: 1,
          sources: [
            { name: "Behind" },
            { name: "EndsAt150", endBlock: 150 },
            { name: "Ahead" },
            { name: "Done", endBlock: 120 },
          ],
          blockHeight: 150,
        }),
      );

      const rows = await testDb.run(syncStore.listBlockSyncProgress({ chainId: 1 }));

      expect(
        rows.map(({ name, syncedBlockHeight, isComplete }) => ({
          name,
          syncedBlockHeight,
          isComplete,
        })),
      ).toStrictEqual([
        { name: "Ahead", syncedBlockHeight: 200n, isComplete: false },
        { name: "Behind", syncedBlockHeight: 150n, isComplete: false },
        { name: "Done", syncedBlockHeight: 120n, isComplete: true },
        { name: "EndsAt150", syncedBlockHeight: 150n, isComplete: true },
      ]);
    });

    test("rewindTo lowers block source progress above the height and reopens it", async () => {
      await upsert("Above", 300, true);
      await upsert("Below", 150);

      await testDb.run(syncStore.rewindTo({ chainId: 1, blockHeight: 200 }));

      const rows = await testDb.run(syncStore.listBlockSyncProgress({ chainId: 1 }));

      expect(rows).toMatchObject([
        { name: "Above", syncedBlockHeight: 200n, isComplete: false },
        { name: "Below", syncedBlockHeight: 150n, isComplete: false },
      ]);
    });
  });

  describe("getStoredBlockHeights", () => {
    test("returns stored heights within the inclusive range on the chain, ascending", async () => {
      await testDb.db
        .insert(blocksTable)
        .values([blockRow(130), blockRow(99), blockRow(100), blockRow(120), blockRow(131)]);
      await testDb.db.insert(blocksTable).values(blockRow(110, 2n));

      await expect(
        testDb.run(
          syncStore.getStoredBlockHeights({ chainId: 1, fromBlockHeight: 100, toBlockHeight: 130 }),
        ),
      ).resolves.toStrictEqual([100, 120, 130]);
    });
  });

  describe("getSourceBlocks", () => {
    const sourceHeights = async (
      sources: { interval: number; startBlock: number; endBlock?: number }[],
      fromBlockHeight: number,
      toBlockHeight?: number,
    ) =>
      (
        await testDb.run(
          syncStore.getSourceBlocks({ chainId: 1, fromBlockHeight, toBlockHeight, sources }),
        )
      ).map((row) => Number(row.blockHeight));

    beforeEach(async () => {
      await testDb.db
        .insert(blocksTable)
        .values(Array.from({ length: 61 }, (_, index) => blockRow(100 + index)));
      await testDb.db.insert(blocksTable).values(blockRow(103, 2n));
    });

    test("returns the stored blocks a source runs at from an unaligned startBlock", async () => {
      await expect(sourceHeights([{ interval: 10, startBlock: 103 }], 0)).resolves.toStrictEqual([
        103, 113, 123, 133, 143, 153,
      ]);
    });

    test("returns no block past the source's endBlock or below its startBlock", async () => {
      await expect(
        sourceHeights([{ interval: 5, startBlock: 110, endBlock: 125 }], 0),
      ).resolves.toStrictEqual([110, 115, 120, 125]);
    });

    test("bounds results by the inclusive height range", async () => {
      await expect(
        sourceHeights([{ interval: 1, startBlock: 100 }], 104, 107),
      ).resolves.toStrictEqual([104, 105, 106, 107]);
    });

    test("returns each block once when several sources run at it", async () => {
      await expect(
        sourceHeights(
          [
            { interval: 20, startBlock: 100 },
            { interval: 30, startBlock: 100 },
          ],
          0,
        ),
      ).resolves.toStrictEqual([100, 120, 130, 140, 160]);
    });

    test("returns the block fields handlers read", async () => {
      await expect(
        testDb.run(
          syncStore.getSourceBlocks({
            chainId: 1,
            fromBlockHeight: 103,
            toBlockHeight: 103,
            sources: [{ interval: 1, startBlock: 0 }],
          }),
        ),
      ).resolves.toStrictEqual([
        {
          blockHeight: 103n,
          blockTime: 1030n,
          blockHash: "block-103",
          indexBlockHash: "index-block-103",
        },
      ]);
    });

    test("returns nothing without sources", async () => {
      await expect(sourceHeights([], 0)).resolves.toStrictEqual([]);
    });
  });

  describe("error handling", () => {
    test("wraps database failures in SyncStoreError", async () => {
      await testDb.db.execute(sql`drop table "stacksindex"."blocks"`);

      const promise = testDb.run(syncStore.insertBlocks({ blocks: [block], chainId: 1 }));

      await expect(promise).rejects.toBeInstanceOf(SyncStoreError);
      await expect(promise).rejects.toMatchObject({ operation: "insertBlocks" });
    });
  });
});
