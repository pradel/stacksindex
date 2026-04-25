import { and, eq, inArray } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { BlockApiResponse, TransactionApiResponse } from "../datasources/api/index.ts";
import { encodeBlock, encodeTransaction } from "./encode.js";
import { blocksTable, syncProgressTable, transactionsTable } from "./schema.js";

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

  getExistingTransactions: async (
    { txIds, chainId }: { txIds: string[]; chainId: number },
    context: Context,
  ) => {
    if (txIds.length === 0) {
      return [];
    }

    const result = await context.db
      .select({ txId: transactionsTable.txId })
      .from(transactionsTable)
      .where(
        and(eq(transactionsTable.chainId, BigInt(chainId)), inArray(transactionsTable.txId, txIds)),
      );

    return result.map((row) => row.txId);
  },

  getExistingBlocks: async (
    { blockHashes, chainId }: { blockHashes: string[]; chainId: number },
    context: Context,
  ) => {
    if (blockHashes.length === 0) {
      return [];
    }

    const result = await context.db
      .select({ hash: blocksTable.hash })
      .from(blocksTable)
      .where(and(eq(blocksTable.chainId, BigInt(chainId)), inArray(blocksTable.hash, blockHashes)));

    return result.map((row) => row.hash);
  },

  getSyncProgress: async (
    { contractId, chainId }: { contractId: string; chainId: number },
    context: Context,
  ): Promise<typeof syncProgressTable.$inferSelect | null> => {
    const result = await context.db
      .select()
      .from(syncProgressTable)
      .where(
        and(
          eq(syncProgressTable.chainId, BigInt(chainId)),
          eq(syncProgressTable.contractId, contractId),
        ),
      )
      .limit(1);

    return result[0] ?? null;
  },

  upsertSyncProgress: async (
    {
      contractId,
      chainId,
      cursor,
      lastBlockHeight,
    }: {
      contractId: string;
      chainId: number;
      cursor: string;
      lastBlockHeight: number;
    },
    context: Context,
  ) => {
    await context.db
      .insert(syncProgressTable)
      .values({
        chainId: BigInt(chainId),
        contractId,
        cursor,
        lastBlockHeight: BigInt(lastBlockHeight),
      })
      .onConflictDoUpdate({
        target: [syncProgressTable.chainId, syncProgressTable.contractId],
        set: {
          cursor,
          lastBlockHeight: BigInt(lastBlockHeight),
        },
      });
  },
};
