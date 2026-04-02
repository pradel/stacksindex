import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { syncStore } from "./index.ts";
import { blocksTable, transactionsTable } from "./schema.ts";

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
});
