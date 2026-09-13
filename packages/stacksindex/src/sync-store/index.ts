import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { Effect } from "effect";

import type {
  SmartContractLogEvent,
  StorableBlock,
  StorableTransaction,
} from "../datasources/api/index.ts";
import { SyncStoreError } from "../lib/errors.ts";
import { encodeBlock, encodeEvent, encodeTransaction } from "./encode.ts";
import {
  blocksTable,
  checkpointsTable,
  eventsTable,
  syncProgressTable,
  transactionsTable,
} from "./schema.ts";

interface Context {
  // oxlint-disable-next-line typescript/no-explicit-any
  db: any;
}

export const syncStore = {
  insertBlocks: (
    { blocks, chainId }: { blocks: StorableBlock[]; chainId: number },
    context: Context,
  ): Effect.Effect<void, SyncStoreError> => {
    if (blocks.length === 0) {
      return Effect.void;
    }

    return context.db
      .insert(blocksTable)
      .values(blocks.map((block) => encodeBlock({ block, chainId })))
      .onConflictDoNothing({
        target: [blocksTable.chainId, blocksTable.height],
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "insertBlocks", cause }),
        ),
      );
  },

  insertTransactions: (
    { transactions, chainId }: { transactions: StorableTransaction[]; chainId: number },
    context: Context,
  ): Effect.Effect<void, SyncStoreError> => {
    if (transactions.length === 0) {
      return Effect.void;
    }

    return context.db
      .insert(transactionsTable)
      .values(transactions.map((tx) => encodeTransaction({ transaction: tx, chainId })))
      .onConflictDoNothing({
        target: [transactionsTable.chainId, transactionsTable.txId],
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "insertTransactions", cause }),
        ),
      );
  },

  getExistingTransactions: (
    { txIds, chainId }: { txIds: string[]; chainId: number },
    context: Context,
  ): Effect.Effect<{ txId: string; blockHeight: bigint }[], SyncStoreError> => {
    if (txIds.length === 0) {
      return Effect.succeed([]);
    }

    return context.db
      .select({ txId: transactionsTable.txId, blockHeight: transactionsTable.blockHeight })
      .from(transactionsTable)
      .where(
        and(eq(transactionsTable.chainId, BigInt(chainId)), inArray(transactionsTable.txId, txIds)),
      )
      .pipe(
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "getExistingTransactions", cause }),
        ),
      );
  },

  getExistingBlocks: (
    { blockHashes, chainId }: { blockHashes: string[]; chainId: number },
    context: Context,
  ): Effect.Effect<string[], SyncStoreError> => {
    if (blockHashes.length === 0) {
      return Effect.succeed([]);
    }

    return context.db
      .select({ hash: blocksTable.hash })
      .from(blocksTable)
      .where(and(eq(blocksTable.chainId, BigInt(chainId)), inArray(blocksTable.hash, blockHashes)))
      .pipe(
        Effect.map((rows: { hash: string }[]) => rows.map((row) => row.hash)),
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "getExistingBlocks", cause }),
        ),
      );
  },

  getSyncProgress: (
    { contractId, chainId }: { contractId: string; chainId: number },
    context: Context,
  ): Effect.Effect<typeof syncProgressTable.$inferSelect | null, SyncStoreError> &
    PromiseLike<typeof syncProgressTable.$inferSelect | null> =>
    context.db
      .select()
      .from(syncProgressTable)
      .where(
        and(
          eq(syncProgressTable.chainId, BigInt(chainId)),
          eq(syncProgressTable.contractId, contractId),
        ),
      )
      .limit(1)
      .pipe(
        Effect.map((rows: (typeof syncProgressTable.$inferSelect)[]) => rows[0] ?? null),
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "getSyncProgress", cause }),
        ),
      ) as Effect.Effect<typeof syncProgressTable.$inferSelect | null, SyncStoreError> &
      PromiseLike<typeof syncProgressTable.$inferSelect | null>,

  upsertSyncProgress: (
    {
      contractId,
      chainId,
      cursor,
      lastBlockHeight,
      isComplete = false,
    }: {
      contractId: string;
      chainId: number;
      cursor: string | null;
      lastBlockHeight: number;
      isComplete?: boolean;
    },
    context: Context,
  ): Effect.Effect<void, SyncStoreError> =>
    context.db
      .insert(syncProgressTable)
      .values({
        chainId: BigInt(chainId),
        contractId,
        cursor,
        lastBlockHeight: BigInt(lastBlockHeight),
        isComplete,
      })
      .onConflictDoUpdate({
        target: [syncProgressTable.chainId, syncProgressTable.contractId],
        set: {
          cursor,
          lastBlockHeight: BigInt(lastBlockHeight),
          isComplete,
        },
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "upsertSyncProgress", cause }),
        ),
      ),

  insertEvents: (
    {
      events,
      chainId,
    }: {
      events: { event: SmartContractLogEvent; blockHeight: number }[];
      chainId: number;
    },
    context: Context,
  ): Effect.Effect<void, SyncStoreError> => {
    if (events.length === 0) {
      return Effect.void;
    }

    return context.db
      .insert(eventsTable)
      .values(events.map(({ event, blockHeight }) => encodeEvent({ event, chainId, blockHeight })))
      .onConflictDoNothing({
        target: [eventsTable.chainId, eventsTable.txId, eventsTable.eventIndex],
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "insertEvents", cause }),
        ),
      );
  },

  getEvents: (
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
  ): Effect.Effect<
    {
      eventIndex: number;
      eventType: string;
      txId: string;
      contractId: string;
      topic: string | null;
      valueHex: string;
      valueRepr: string;
      blockHeight: bigint;
      blockTime: bigint;
      txIndex: number;
      senderAddress: string;
    }[],
    SyncStoreError
  > &
    PromiseLike<
      {
        eventIndex: number;
        eventType: string;
        txId: string;
        contractId: string;
        topic: string | null;
        valueHex: string;
        valueRepr: string;
        blockHeight: bigint;
        blockTime: bigint;
        txIndex: number;
        senderAddress: string;
      }[]
    > => {
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
      .orderBy(eventsTable.blockHeight, transactionsTable.txIndex, eventsTable.eventIndex)
      .pipe(
        Effect.mapError((cause: unknown) => new SyncStoreError({ operation: "getEvents", cause })),
      ) as unknown as Effect.Effect<
      {
        eventIndex: number;
        eventType: string;
        txId: string;
        contractId: string;
        topic: string | null;
        valueHex: string;
        valueRepr: string;
        blockHeight: bigint;
        blockTime: bigint;
        txIndex: number;
        senderAddress: string;
      }[],
      SyncStoreError
    > &
      PromiseLike<
        {
          eventIndex: number;
          eventType: string;
          txId: string;
          contractId: string;
          topic: string | null;
          valueHex: string;
          valueRepr: string;
          blockHeight: bigint;
          blockTime: bigint;
          txIndex: number;
          senderAddress: string;
        }[]
      >;
  },

  getCheckpoint: (
    { chainId }: { chainId: number },
    context: Context,
  ): Effect.Effect<typeof checkpointsTable.$inferSelect | null, SyncStoreError> &
    PromiseLike<typeof checkpointsTable.$inferSelect | null> =>
    context.db
      .select()
      .from(checkpointsTable)
      .where(eq(checkpointsTable.chainId, BigInt(chainId)))
      .limit(1)
      .pipe(
        Effect.map((rows: (typeof checkpointsTable.$inferSelect)[]) => rows[0] ?? null),
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "getCheckpoint", cause }),
        ),
      ) as Effect.Effect<typeof checkpointsTable.$inferSelect | null, SyncStoreError> &
      PromiseLike<typeof checkpointsTable.$inferSelect | null>,

  upsertCheckpoint: (
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
  ): Effect.Effect<void, SyncStoreError> =>
    context.db
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
      })
      .pipe(
        Effect.asVoid,
        Effect.mapError(
          (cause: unknown) => new SyncStoreError({ operation: "upsertCheckpoint", cause }),
        ),
      ),
};
