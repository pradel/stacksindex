import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { BlockApiResponse } from "../datasources/api/index.ts";
import { encodeBlock } from "./encode.js";
import { blocksTable } from "./schema.js";

interface Context {
  db: NodePgDatabase;
}

export const syncStore = {
  insertBlocks: async ({ blocks }: { blocks: BlockApiResponse[] }, context: Context) => {
    if (blocks.length === 0) {
      return;
    }

    // TODO: support multiple chains
    const chainId = 1;

    await context.db
      .insert(blocksTable)
      .values(blocks.map((block) => encodeBlock({ block, chainId })))
      .onConflictDoNothing({
        target: [blocksTable.chainId, blocksTable.height],
      });
  },
};
