import { and, eq, gte, inArray, lte } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgQueryResultHKT, PgTransaction } from "drizzle-orm/pg-core";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type {
  BlockApiResponse,
  SmartContractLogEvent,
  TransactionApiResponse,
} from "../datasources/api/index.ts";
import { encodeBlock, encodeEvent, encodeTransaction } from "./encode.js";
import {
  blocksTable,
  checkpointsTable,
  eventsTable,
  syncProgressTable,
  transactionsTable,
} from "./schema.js";

interface Context {
  db:
    | NodePgDatabase
    | PgliteDatabase
    // Accept Drizzle transaction objects from db.transaction(). Generic params
    // Are intentionally broad to accept PgliteTransaction with any schema.
    // oxlint-disable-next-line typescript-eslint/no-explicit-any
    | PgTransaction<PgQueryResultHKT, any, any>;
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

  insertEvents: async (
    { events }: { events: { event: SmartContractLogEvent; blockHeight: number }[] },
    context: Context,
  ) => {
    if (events.length === 0) {
      return;
    }

    const chainId = 1;

    await context.db
      .insert(eventsTable)
      .values(events.map(({ event, blockHeight }) => encodeEvent({ event, chainId, blockHeight })))
      .onConflictDoNothing({
        target: [eventsTable.chainId, eventsTable.txId, eventsTable.eventIndex],
      });
  },

  getEvents: async (
    {
      chainId,
      fromBlockHeight,
      toBlockHeight,
    }: {
      chainId: number;
      fromBlockHeight: number;
      toBlockHeight?: number;
    },
    context: Context,
  ) => {
    const conditions = [
      eq(eventsTable.chainId, BigInt(chainId)),
      gte(eventsTable.blockHeight, BigInt(fromBlockHeight)),
    ];
    if (toBlockHeight !== undefined) {
      conditions.push(lte(eventsTable.blockHeight, BigInt(toBlockHeight)));
    }

    return context.db
      .select({
        eventIndex: eventsTable.eventIndex,
        eventType: eventsTable.eventType,
        txId: eventsTable.txId,
        contractId: eventsTable.contractId,
        topic: eventsTable.topic,
        valueHex: eventsTable.valueHex,
        valueRepr: eventsTable.valueRepr,
        blockHeight: eventsTable.blockHeight,
        blockTime: blocksTable.blockTime,
        txIndex: transactionsTable.txIndex,
        senderAddress: transactionsTable.senderAddress,
      })
      .from(eventsTable)
      .innerJoin(
        transactionsTable,
        and(
          eq(eventsTable.chainId, transactionsTable.chainId),
          eq(eventsTable.txId, transactionsTable.txId),
        ),
      )
      .innerJoin(
        blocksTable,
        and(
          eq(transactionsTable.chainId, blocksTable.chainId),
          eq(transactionsTable.blockHeight, blocksTable.height),
        ),
      )
      .where(and(...conditions))
      .orderBy(eventsTable.blockHeight, transactionsTable.txIndex, eventsTable.eventIndex);
  },

  getCheckpoint: async (
    { chainId }: { chainId: number },
    context: Context,
  ): Promise<typeof checkpointsTable.$inferSelect | null> => {
    const result = await context.db
      .select()
      .from(checkpointsTable)
      .where(eq(checkpointsTable.chainId, BigInt(chainId)))
      .limit(1);

    return result[0] ?? null;
  },

  upsertCheckpoint: async (
    {
      chainId,
      blockHeight,
      blockTime,
    }: {
      chainId: number;
      blockHeight: number;
      blockTime: number;
    },
    context: Context,
  ) => {
    await context.db
      .insert(checkpointsTable)
      .values({
        chainId: BigInt(chainId),
        blockHeight: BigInt(blockHeight),
        blockTime: BigInt(blockTime),
      })
      .onConflictDoUpdate({
        target: [checkpointsTable.chainId],
        set: {
          blockHeight: BigInt(blockHeight),
          blockTime: BigInt(blockTime),
        },
      });
  },
};
