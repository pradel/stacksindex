import type { BlockApiResponse } from "../datasources/api/index.ts";
import type * as ponderSyncSchema from "./schema.js";

export const encodeBlock = ({
  block,
  chainId,
}: {
  block: BlockApiResponse;
  chainId: number;
}): typeof ponderSyncSchema.blocksTable.$inferInsert => ({
  chainId: BigInt(chainId),
  height: BigInt(block.height),
  hash: block.hash,
  blockTime: BigInt(block.burn_block_time),
  tenureHeight: BigInt(block.burn_block_height),
});
