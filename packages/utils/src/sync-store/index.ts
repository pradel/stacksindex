import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { BlockApiResponse, TransactionApiResponse } from "../datasources/api/index.ts";
import { encodeBlock, encodeTransaction } from "./encode.js";
import { blocksTable, transactionsTable } from "./schema.js";

interface Context {
  db: NodePgDatabase;
}

export const syncStore = {
  insertBlocks: async ({ blocks }: { blocks: BlockApiResponse[] }, context: Context) => {
    if (blocks.length === 0) {
      return;
    }

    const chainId = 1;

    await context.db
      .insert(blocksTable)
      .values(blocks.map((block) => encodeBlock({ block, chainId })))
      .onConflictDoNothing({
        target: [blocksTable.chainId, blocksTable.height],
      });
  },

  insertTransactions: async (
    { transactions }: { transactions: TransactionApiResponse[] },
    context: Context,
  ) => {
    if (transactions.length === 0) {
      return;
    }

    const chainId = 1;

    await context.db
      .insert(transactionsTable)
      .values(transactions.map((tx) => encodeTransaction({ transaction: tx, chainId })))
      .onConflictDoNothing({
        target: [transactionsTable.chainId, transactionsTable.txId],
      });
  },
};
