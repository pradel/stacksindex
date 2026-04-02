import { afterAll, beforeAll, beforeEach, describe, test } from "vite-plus/test";

import { createTestDatabase, type TestDatabase } from "../test/database.ts";
import { syncStore } from "./index.ts";

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
    });
  });
});
