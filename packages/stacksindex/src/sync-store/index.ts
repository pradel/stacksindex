import { and, eq, gt, gte, inArray, lt, lte } from "drizzle-orm";
import { Effect } from "effect";

import { IndexerDatabase } from "../database/index.ts";
import type {
  SmartContractLogEvent,
  StorableBlock,
  StorableTransaction,
} from "../datasources/api/index.ts";
import { SyncStoreError } from "../lib/errors.ts";
import { decodeStoredEvents, type StoredEvent } from "./decode.ts";
import { encodeBlock, encodeEvent, encodeTransaction } from "./encode.ts";
import {
  blocksTable,
  checkpointsTable,
  eventsTable,
  metaTable,
  type RecordedContract,
  syncAnchorsTable,
  syncProgressTable,
  transactionsTable,
} from "./schema.ts";

export const syncStore = {
  insertBlocks: ({
    blocks,
    chainId,
  }: {
    blocks: StorableBlock[];
    chainId: number;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      if (blocks.length === 0) {
        return;
      }

      const db = yield* IndexerDatabase;

      yield* db
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
    }),

  insertTransactions: ({
    transactions,
    chainId,
  }: {
    transactions: StorableTransaction[];
    chainId: number;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      if (transactions.length === 0) {
        return;
      }

      const db = yield* IndexerDatabase;

      yield* db
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
    }),

  getExistingTransactions: ({
    txIds,
    chainId,
  }: {
    txIds: string[];
    chainId: number;
  }): Effect.Effect<{ txId: string; blockHeight: bigint }[], SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      if (txIds.length === 0) {
        return [];
      }

      const db = yield* IndexerDatabase;

      return yield* db
        .select({ txId: transactionsTable.txId, blockHeight: transactionsTable.blockHeight })
        .from(transactionsTable)
        .where(
          and(
            eq(transactionsTable.chainId, BigInt(chainId)),
            inArray(transactionsTable.txId, txIds),
          ),
        )
        .pipe(
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "getExistingTransactions", cause }),
          ),
        );
    }),

  getExistingBlocks: ({
    blockHashes,
    chainId,
  }: {
    blockHashes: string[];
    chainId: number;
  }): Effect.Effect<string[], SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      if (blockHashes.length === 0) {
        return [];
      }

      const db = yield* IndexerDatabase;

      return yield* db
        .select({ hash: blocksTable.hash })
        .from(blocksTable)
        .where(
          and(eq(blocksTable.chainId, BigInt(chainId)), inArray(blocksTable.hash, blockHashes)),
        )
        .pipe(
          Effect.map((rows: { hash: string }[]) => rows.map((row) => row.hash)),
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "getExistingBlocks", cause }),
          ),
        );
    }),

  getSyncProgress: ({
    contractId,
    chainId,
  }: {
    contractId: string;
    chainId: number;
  }): Effect.Effect<
    typeof syncProgressTable.$inferSelect | null,
    SyncStoreError,
    IndexerDatabase
  > =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      // SAFETY: context.db is a drizzle Effect database, so its select builder resolves to rows of syncProgressTable.
      return yield* db
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
        );
    }),

  /** Every contract's sync progress on the chain, ordered by contract id. */
  listSyncProgress: ({
    chainId,
  }: {
    chainId: number;
  }): Effect.Effect<(typeof syncProgressTable.$inferSelect)[], SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      return yield* db
        .select()
        .from(syncProgressTable)
        .where(eq(syncProgressTable.chainId, BigInt(chainId)))
        .orderBy(syncProgressTable.contractId)
        .pipe(
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "listSyncProgress", cause }),
          ),
        );
    }),

  upsertSyncProgress: ({
    contractId,
    chainId,
    cursor,
    syncedBlockHeight,
    isComplete = false,
  }: {
    contractId: string;
    chainId: number;
    cursor: string | null;
    syncedBlockHeight: number;
    isComplete?: boolean;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      yield* db
        .insert(syncProgressTable)
        .values({
          chainId: BigInt(chainId),
          contractId,
          cursor,
          syncedBlockHeight: BigInt(syncedBlockHeight),
          isComplete,
        })
        .onConflictDoUpdate({
          target: [syncProgressTable.chainId, syncProgressTable.contractId],
          set: {
            cursor,
            syncedBlockHeight: BigInt(syncedBlockHeight),
            isComplete,
          },
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "upsertSyncProgress", cause }),
          ),
        );
    }),

  /**
   * Raises `syncedBlockHeight` to `blockHeight` for the given contracts that
   * are still syncing (not complete at their end block) and lower than it.
   * Callers must have stored every event of those contracts up to
   * `blockHeight`, e.g. after a sync pass that fetched their newest events
   * once the tip `blockHeight` was read.
   */
  raiseSyncedBlockHeight: ({
    chainId,
    contractIds,
    blockHeight,
  }: {
    chainId: number;
    contractIds: readonly string[];
    blockHeight: number;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      if (contractIds.length === 0) {
        return;
      }

      const db = yield* IndexerDatabase;

      yield* db
        .update(syncProgressTable)
        .set({ syncedBlockHeight: BigInt(blockHeight) })
        .where(
          and(
            eq(syncProgressTable.chainId, BigInt(chainId)),
            inArray(syncProgressTable.contractId, [...contractIds]),
            eq(syncProgressTable.isComplete, false),
            lt(syncProgressTable.syncedBlockHeight, BigInt(blockHeight)),
          ),
        );
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "raiseSyncedBlockHeight", cause }),
      ),
    ),

  insertEvents: ({
    events,
    chainId,
  }: {
    events: { event: SmartContractLogEvent; blockHeight: number }[];
    chainId: number;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      if (events.length === 0) {
        return;
      }

      const db = yield* IndexerDatabase;

      yield* db
        .insert(eventsTable)
        .values(
          events.map(({ event, blockHeight }) => encodeEvent({ event, chainId, blockHeight })),
        )
        .onConflictDoNothing({
          target: [eventsTable.chainId, eventsTable.txId, eventsTable.eventIndex],
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "insertEvents", cause }),
          ),
        );
    }),

  getEvents: ({
    chainId,
    fromBlockHeight,
    toBlockHeight,
  }: {
    chainId: number;
    fromBlockHeight: number;
    toBlockHeight?: number;
  }): Effect.Effect<readonly StoredEvent[], SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      const conditions = [
        eq(eventsTable.chainId, BigInt(chainId)),
        gte(eventsTable.blockHeight, BigInt(fromBlockHeight)),
      ];

      if (toBlockHeight !== undefined) {
        conditions.push(lte(eventsTable.blockHeight, BigInt(toBlockHeight)));
      }

      // SAFETY: context.db is a drizzle Effect database, so this join builder resolves to the events projection declared above.
      const rows = yield* db
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
          blockHash: blocksTable.hash,
          indexBlockHash: blocksTable.indexBlockHash,
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
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "getEvents", cause }),
          ),
        );

      return yield* decodeStoredEvents(rows).pipe(
        Effect.mapError((cause) => new SyncStoreError({ operation: "getEvents", cause })),
      );
    }),

  getCheckpoint: ({
    chainId,
  }: {
    chainId: number;
  }): Effect.Effect<typeof checkpointsTable.$inferSelect | null, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      // SAFETY: context.db is a drizzle Effect database, so its select builder resolves to rows of checkpointsTable.
      return yield* db
        .select()
        .from(checkpointsTable)
        .where(eq(checkpointsTable.chainId, BigInt(chainId)))
        .limit(1)
        .pipe(
          Effect.map((rows: (typeof checkpointsTable.$inferSelect)[]) => rows[0] ?? null),
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "getCheckpoint", cause }),
          ),
        );
    }),

  upsertCheckpoint: ({
    chainId,
    blockHeight,
    blockTime,
    finalizedBlockHeight,
    finalizedBlockTime,
  }: {
    chainId: number;
    blockHeight: number;
    blockTime: number;
    finalizedBlockHeight: number;
    finalizedBlockTime: number;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      yield* db
        .insert(checkpointsTable)
        .values({
          chainId: BigInt(chainId),
          blockHeight: BigInt(blockHeight),
          blockTime: BigInt(blockTime),
          finalizedBlockHeight: BigInt(finalizedBlockHeight),
          finalizedBlockTime: BigInt(finalizedBlockTime),
        })
        .onConflictDoUpdate({
          target: [checkpointsTable.chainId],
          set: {
            blockHeight: BigInt(blockHeight),
            blockTime: BigInt(blockTime),
            finalizedBlockHeight: BigInt(finalizedBlockHeight),
            finalizedBlockTime: BigInt(finalizedBlockTime),
          },
        })
        .pipe(
          Effect.asVoid,
          Effect.mapError(
            (cause: unknown) => new SyncStoreError({ operation: "upsertCheckpoint", cause }),
          ),
        );
    }),

  /** Deletes the checkpoint, so indexing starts over from the first stored event. */
  deleteCheckpoint: ({
    chainId,
  }: {
    chainId: number;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      yield* db.delete(checkpointsTable).where(eq(checkpointsTable.chainId, BigInt(chainId)));
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "deleteCheckpoint", cause }),
      ),
    ),

  /** Deletes the contracts' sync progress, so the next sync fetches them from their start. */
  deleteSyncProgress: ({
    chainId,
    contractIds,
  }: {
    chainId: number;
    contractIds: readonly string[];
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      if (contractIds.length === 0) {
        return;
      }

      const db = yield* IndexerDatabase;

      yield* db
        .delete(syncProgressTable)
        .where(
          and(
            eq(syncProgressTable.chainId, BigInt(chainId)),
            inArray(syncProgressTable.contractId, [...contractIds]),
          ),
        );
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "deleteSyncProgress", cause }),
      ),
    ),

  /**
   * Discards all sync data above `blockHeight` and lowers the affected
   * `sync_progress` rows to it, so the next sync refetches that range from the
   * canonical chain: the affected contracts drop their forward cursor and
   * catch up from the newest events down to `blockHeight`. A checkpoint above
   * `blockHeight` is lowered to it so the range is replayed through handlers.
   * Handler writes are not rolled back, so handlers must be idempotent.
   *
   * Returns the replayed range, or `null` when no indexed data was discarded.
   */
  rewindTo: ({
    chainId,
    blockHeight,
  }: {
    chainId: number;
    blockHeight: number;
  }): Effect.Effect<
    { fromBlockHeight: number; toBlockHeight: number } | null,
    SyncStoreError,
    IndexerDatabase
  > =>
    IndexerDatabase.transaction(() =>
      Effect.gen(function* () {
        const db = yield* IndexerDatabase;
        const height = BigInt(blockHeight);

        const [checkpoint] = yield* db
          .select()
          .from(checkpointsTable)
          .where(eq(checkpointsTable.chainId, BigInt(chainId)))
          .limit(1);

        yield* db
          .delete(eventsTable)
          .where(
            and(eq(eventsTable.chainId, BigInt(chainId)), gt(eventsTable.blockHeight, height)),
          );

        yield* db
          .delete(transactionsTable)
          .where(
            and(
              eq(transactionsTable.chainId, BigInt(chainId)),
              gt(transactionsTable.blockHeight, height),
            ),
          );

        yield* db
          .delete(blocksTable)
          .where(and(eq(blocksTable.chainId, BigInt(chainId)), gt(blocksTable.height, height)));

        yield* db
          .update(syncProgressTable)
          .set({ cursor: null, syncedBlockHeight: height, isComplete: false })
          .where(
            and(
              eq(syncProgressTable.chainId, BigInt(chainId)),
              gt(syncProgressTable.syncedBlockHeight, height),
            ),
          );

        if (checkpoint === undefined || checkpoint.blockHeight <= height) {
          return null;
        }

        const [block] = yield* db
          .select({ blockTime: blocksTable.blockTime })
          .from(blocksTable)
          .where(and(eq(blocksTable.chainId, BigInt(chainId)), eq(blocksTable.height, height)))
          .limit(1);

        // The finalized block time is recorded even when its block row is not
        // Stored (e.g. a checkpoint finalized at the chain tip).
        const blockTime =
          checkpoint.finalizedBlockHeight === height
            ? checkpoint.finalizedBlockTime
            : (block?.blockTime ?? 0n);

        yield* db
          .update(checkpointsTable)
          .set({ blockHeight: height, blockTime })
          .where(eq(checkpointsTable.chainId, BigInt(chainId)));

        return { fromBlockHeight: Number(checkpoint.blockHeight), toBlockHeight: blockHeight };
      }),
    ).pipe(
      Effect.mapError((cause: unknown) => new SyncStoreError({ operation: "rewindTo", cause })),
    ),

  /** Stored block heights and hashes within `[fromBlockHeight, toBlockHeight]`, ascending. */
  getStoredBlocks: ({
    chainId,
    fromBlockHeight,
    toBlockHeight,
  }: {
    chainId: number;
    fromBlockHeight: number;
    toBlockHeight: number;
  }): Effect.Effect<{ height: number; hash: string }[], SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      const rows = yield* db
        .select({ height: blocksTable.height, hash: blocksTable.hash })
        .from(blocksTable)
        .where(
          and(
            eq(blocksTable.chainId, BigInt(chainId)),
            gte(blocksTable.height, BigInt(fromBlockHeight)),
            lte(blocksTable.height, BigInt(toBlockHeight)),
          ),
        )
        .orderBy(blocksTable.height);

      return rows.map((row) => ({ height: Number(row.height), hash: row.hash }));
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "getStoredBlocks", cause }),
      ),
    ),

  getSyncAnchor: ({
    chainId,
  }: {
    chainId: number;
  }): Effect.Effect<
    { blockHeight: number; blockHash: string } | null,
    SyncStoreError,
    IndexerDatabase
  > =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      const [row] = yield* db
        .select()
        .from(syncAnchorsTable)
        .where(eq(syncAnchorsTable.chainId, BigInt(chainId)))
        .limit(1);

      return row === undefined
        ? null
        : { blockHeight: Number(row.blockHeight), blockHash: row.blockHash };
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "getSyncAnchor", cause }),
      ),
    ),

  /** Saves the anchor, or removes it when `anchor` is `null`. */
  setSyncAnchor: ({
    chainId,
    anchor,
  }: {
    chainId: number;
    anchor: { blockHeight: number; blockHash: string } | null;
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      if (anchor === null) {
        yield* db.delete(syncAnchorsTable).where(eq(syncAnchorsTable.chainId, BigInt(chainId)));

        return;
      }

      const values = {
        blockHeight: BigInt(anchor.blockHeight),
        blockHash: anchor.blockHash,
      };

      yield* db
        .insert(syncAnchorsTable)
        .values({ chainId: BigInt(chainId), ...values })
        .onConflictDoUpdate({ target: [syncAnchorsTable.chainId], set: values });
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "setSyncAnchor", cause }),
      ),
    ),

  /** Contracts recorded for the chain by the last `run` or `live`, or `null` before the first. */
  getRecordedContracts: ({
    chainId,
  }: {
    chainId: number;
  }): Effect.Effect<readonly RecordedContract[] | null, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;

      const [row] = yield* db
        .select({ contracts: metaTable.contracts })
        .from(metaTable)
        .where(eq(metaTable.chainId, BigInt(chainId)))
        .limit(1);

      return row === undefined ? null : row.contracts;
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "getRecordedContracts", cause }),
      ),
    ),

  recordContracts: ({
    chainId,
    contracts,
  }: {
    chainId: number;
    contracts: readonly RecordedContract[];
  }): Effect.Effect<void, SyncStoreError, IndexerDatabase> =>
    Effect.gen(function* () {
      const db = yield* IndexerDatabase;
      const values = { contracts: [...contracts] };

      yield* db
        .insert(metaTable)
        .values({ chainId: BigInt(chainId), ...values })
        .onConflictDoUpdate({ target: [metaTable.chainId], set: values });
    }).pipe(
      Effect.mapError(
        (cause: unknown) => new SyncStoreError({ operation: "recordContracts", cause }),
      ),
    ),
};
