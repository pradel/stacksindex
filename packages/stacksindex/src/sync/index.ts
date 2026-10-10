import { Cause, Context, Duration, Effect, Layer, Metric, Queue, Stream } from "effect";

import { type IndexerDb, IndexerDatabase } from "../database/index.ts";
import {
  type StacksApiError,
  StacksClient,
  type StacksClientService,
  type StorableBlock,
  type StorableTransaction,
} from "../datasources/api/index.ts";
import { chunkArray } from "../lib/array.ts";
import {
  type DatabaseError,
  type InvalidCursorError,
  type SyncStoreError,
  TransactionBatchError,
} from "../lib/errors.ts";
import { SLOW_OPERATION_MILLIS } from "../lib/logging.ts";
import { syncErrors, syncEvents, syncPages } from "../lib/metrics.ts";
import { syncStore } from "../sync-store/index.ts";
import { getContractEventsFirstCursor, parseLogsCursor } from "./cursor.ts";

/**
 * Max transaction ids per `GET /extended/v3/transactions/batch` call.
 * The API returns summaries for up to 20 mined transactions per request.
 */
const TRANSACTIONS_BATCH_LIMIT = 20;

/**
 * Max contracts initialized (DB read plus cursor discovery) concurrently.
 * Bounded to keep the rate limiter and database from being flooded.
 */
const INITIALIZE_CONCURRENCY = 8;

/**
 * Filter resolved by the runtime: `endBlock` is resolved to a concrete height
 * and the handler is stripped because the syncer only needs to know what to
 * fetch.
 */
export interface SyncFilter {
  readonly contractId: string;
  readonly startBlock?: number;
  readonly endBlock?: number;
}

export type SyncError =
  | StacksApiError
  | InvalidCursorError
  | SyncStoreError
  | TransactionBatchError
  | DatabaseError;

/**
 * Per-contract snapshot surfaced to the runtime to build `RunResult`.
 * `doneAtStart` distinguishes "was already fully synced" (`status:
 * "up-to-date"`) from "was synced during this run" (`status: "completed"`).
 */
export interface ContractSyncSummary {
  readonly contractId: string;
  readonly doneAtStart: boolean;
  readonly startBlock?: number;
  readonly endBlock?: number;
  readonly lastBlockHeight?: number;
  /** Height at which this run began syncing (cursor discovery or saved progress). */
  readonly initialBlockHeight?: number;
  readonly pagesFetched: number;
  readonly transactionsFetched: number;
  /** Smart contract log events stored by this run. */
  readonly eventsStored: number;
}

/**
 * Values emitted by `SyncService.historical`.
 *
 * - `started`: initial per-contract snapshot, emitted before any fetch.
 * - `safe`: a block height whose events are all durably stored for every
 *   active contract.
 * - `completed`: final per-contract snapshot, emitted once every contract is
 *   synced.
 */
export type SyncEvent =
  | { readonly type: "started"; readonly contracts: readonly ContractSyncSummary[] }
  | {
      readonly type: "safe";
      readonly safeBlockHeight: number;
      readonly contracts: readonly ContractSyncSummary[];
    }
  | { readonly type: "completed"; readonly contracts: readonly ContractSyncSummary[] };

export interface SyncService {
  /**
   * Streams safe-to-index block heights for `filters` in ascending order.
   * The stream fails on any sync error and ends once every contract is synced.
   */
  readonly historical: (filters: readonly SyncFilter[]) => Stream.Stream<SyncEvent, SyncError>;
}

interface ContractSyncState {
  contractId: string;
  cursor: string | null;
  syncedBlockHeight?: number;
  initialBlockHeight?: number;
  pagesFetched?: number;
  transactionsFetched?: number;
  eventsStored?: number;
  done: boolean;
  doneAtStart: boolean;
  startBlock?: number;
  endBlock?: number;
}

function getSafeBlockHeight(states: ContractSyncState[]): number | undefined {
  const activeStates = states.filter((state) => !state.done);

  if (activeStates.length === 0) {
    return undefined;
  }

  let minHeight: number | undefined = undefined;

  for (const state of activeStates) {
    if (state.syncedBlockHeight !== undefined) {
      if (minHeight === undefined || state.syncedBlockHeight < minHeight) {
        minHeight = state.syncedBlockHeight;
      }
    }
  }

  return minHeight;
}

function toContractSyncSummary(state: ContractSyncState): ContractSyncSummary {
  return {
    contractId: state.contractId,
    doneAtStart: state.doneAtStart,
    startBlock: state.startBlock,
    endBlock: state.endBlock,
    lastBlockHeight: state.syncedBlockHeight,
    initialBlockHeight: state.initialBlockHeight,
    pagesFetched: state.pagesFetched ?? 0,
    transactionsFetched: state.transactionsFetched ?? 0,
    eventsStored: state.eventsStored ?? 0,
  };
}

function initContractFromScratch(
  filter: SyncFilter,
  chainId: number,
): Effect.Effect<
  ContractSyncState,
  StacksApiError | InvalidCursorError | SyncStoreError,
  StacksClient | IndexerDatabase
> {
  return Effect.gen(function* () {
    const cursor = yield* getContractEventsFirstCursor(filter.contractId, {
      startBlock: filter.startBlock,
    });

    if (!cursor) {
      yield* Effect.logInfo(`No events found for ${filter.contractId}, skipping`).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: filter.contractId,
          phase: "init",
        }),
      );
      yield* syncStore.upsertSyncProgress({
        contractId: filter.contractId,
        chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock ?? 0,
        isComplete: filter.endBlock !== undefined,
      });

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock ?? 0,
        initialBlockHeight: filter.endBlock ?? 0,
        done: true,
        doneAtStart: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const cursorHeight = (yield* parseLogsCursor(cursor)).blockHeight;

    if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
      yield* Effect.logInfo(
        `First event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
      ).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: filter.contractId,
          phase: "init",
          block: cursorHeight,
        }),
      );
      yield* syncStore.upsertSyncProgress({
        contractId: filter.contractId,
        chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock,
        isComplete: true,
      });

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock,
        initialBlockHeight: filter.endBlock,
        done: true,
        doneAtStart: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    yield* Effect.logInfo(`Starting sync for ${filter.contractId} from block ${cursorHeight}`).pipe(
      Effect.annotateLogs({
        chainId,
        contractId: filter.contractId,
        phase: "init",
        block: cursorHeight,
      }),
    );

    return {
      contractId: filter.contractId,
      cursor,
      syncedBlockHeight: Math.max(cursorHeight - 1, 0),
      initialBlockHeight: cursorHeight,
      done: false,
      doneAtStart: false,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    };
  });
}

function initContractFromSaved(
  filter: SyncFilter,
  saved: NonNullable<Effect.Success<ReturnType<typeof syncStore.getSyncProgress>>>,
  chainId: number,
): Effect.Effect<
  ContractSyncState,
  StacksApiError | InvalidCursorError | SyncStoreError,
  StacksClient | IndexerDatabase
> {
  return Effect.gen(function* () {
    const savedHeight = Number(saved.lastBlockHeight);

    const isAlreadyComplete =
      saved.isComplete && filter.endBlock !== undefined && savedHeight >= filter.endBlock;

    if (isAlreadyComplete) {
      yield* Effect.logInfo(
        `Sync already completed for ${filter.contractId} (synced up to block ${savedHeight}), skipping`,
      ).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: filter.contractId,
          phase: "init",
          block: savedHeight,
        }),
      );

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: savedHeight,
        initialBlockHeight: savedHeight,
        done: true,
        doneAtStart: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    if (filter.endBlock !== undefined && savedHeight > filter.endBlock) {
      yield* Effect.logInfo(
        `Resumed progress for ${filter.contractId} at block ${savedHeight} exceeds endBlock ${filter.endBlock}, marking done`,
      ).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: filter.contractId,
          phase: "init",
          block: savedHeight,
        }),
      );

      return {
        contractId: filter.contractId,
        cursor: saved.cursor,
        syncedBlockHeight: savedHeight,
        initialBlockHeight: savedHeight,
        done: true,
        doneAtStart: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    if (saved.cursor) {
      yield* Effect.logInfo(
        `Resuming sync for ${filter.contractId} from block ${savedHeight}`,
      ).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: filter.contractId,
          phase: "init",
          block: savedHeight,
        }),
      );

      return {
        contractId: filter.contractId,
        cursor: saved.cursor,
        syncedBlockHeight: Math.max(savedHeight - 1, 0),
        initialBlockHeight: savedHeight,
        done: false,
        doneAtStart: false,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const cursor = yield* getContractEventsFirstCursor(filter.contractId, {
      startBlock: Math.max(filter.startBlock ?? 0, savedHeight + 1),
    });

    if (!cursor) {
      yield* syncStore.upsertSyncProgress({
        contractId: filter.contractId,
        chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock ?? savedHeight,
        isComplete: filter.endBlock !== undefined,
      });

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock ?? savedHeight,
        initialBlockHeight: savedHeight,
        done: true,
        doneAtStart: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const cursorHeight = (yield* parseLogsCursor(cursor)).blockHeight;

    if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
      yield* Effect.logInfo(
        `Next event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
      ).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: filter.contractId,
          phase: "init",
          block: cursorHeight,
        }),
      );
      yield* syncStore.upsertSyncProgress({
        contractId: filter.contractId,
        chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock,
        isComplete: true,
      });

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock,
        initialBlockHeight: savedHeight,
        done: true,
        doneAtStart: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    return {
      contractId: filter.contractId,
      cursor,
      syncedBlockHeight: savedHeight,
      initialBlockHeight: savedHeight,
      done: false,
      doneAtStart: false,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    };
  });
}

function initializeContractStates(
  filters: readonly SyncFilter[],
  chainId: number,
): Effect.Effect<
  ContractSyncState[],
  StacksApiError | InvalidCursorError | SyncStoreError,
  StacksClient | IndexerDatabase
> {
  return Effect.forEach(
    filters,
    (filter) =>
      Effect.gen(function* () {
        const saved = yield* syncStore.getSyncProgress({
          contractId: filter.contractId,
          chainId,
        });

        return saved === null
          ? yield* initContractFromScratch(filter, chainId)
          : yield* initContractFromSaved(filter, saved, chainId);
      }),
    { concurrency: INITIALIZE_CONCURRENCY },
  );
}

function fetchChunkViaBatch(
  chunk: string[],
): Effect.Effect<StorableTransaction[], StacksApiError | TransactionBatchError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    const batchResponse = yield* client.getTransactionsBatch(chunk);
    // The batch endpoint returns mined transactions in newest-first
    // Order, not in request order, and omits unknown / mempool
    // Ids instead of erroring. Index by id to restore request order.
    const byId = new Map(batchResponse.results.map((tx) => [tx.tx_id, tx]));
    const missingIds = chunk.filter((txId) => !byId.has(txId));

    if (missingIds.length > 0) {
      return yield* Effect.fail(new TransactionBatchError({ missingIds }));
    }

    const ordered: StorableTransaction[] = [];

    for (const txId of chunk) {
      const transaction = byId.get(txId);

      if (transaction !== undefined) {
        ordered.push(transaction);
      }
    }

    return ordered;
  });
}

function fetchMissingTransactions(
  txIds: string[],
  maxBlockHeight?: number,
): Effect.Effect<StorableTransaction[], StacksApiError | TransactionBatchError, StacksClient> {
  return Effect.gen(function* () {
    const transactions: StorableTransaction[] = [];

    for (const chunk of chunkArray(txIds, TRANSACTIONS_BATCH_LIMIT)) {
      const candidates = yield* fetchChunkViaBatch(chunk);

      const inRange = candidates.filter(
        (transaction) => maxBlockHeight === undefined || transaction.block.height <= maxBlockHeight,
      );

      transactions.push(...inRange);

      if (inRange.length !== candidates.length) {
        break;
      }
    }

    return transactions;
  });
}

function extractBlocksFromTransactions(transactions: StorableTransaction[]): StorableBlock[] {
  const byHash = new Map<string, StorableBlock>();

  for (const transaction of transactions) {
    if (!byHash.has(transaction.block.hash)) {
      byHash.set(transaction.block.hash, {
        height: transaction.block.height,
        hash: transaction.block.hash,
        burn_block_time: transaction.bitcoin_block.time,
        burn_block_height: transaction.bitcoin_block.height,
      });
    }
  }

  return Array.from(byHash.values());
}

function advanceContractSyncState(
  lowestState: ContractSyncState,
  currentHeight: number,
  nextCursor: string | null,
  chainId: number,
): Effect.Effect<void, InvalidCursorError | SyncStoreError, IndexerDatabase> {
  return Effect.gen(function* () {
    lowestState.syncedBlockHeight = currentHeight - 1;

    if (nextCursor) {
      const lastBlockHeight = (yield* parseLogsCursor(nextCursor)).blockHeight;
      const { endBlock } = lowestState;
      const isPastEndBlock = endBlock !== undefined && currentHeight > endBlock;

      if (endBlock !== undefined && isPastEndBlock) {
        yield* Effect.logInfo(
          `Sync reached endBlock ${endBlock} for ${lowestState.contractId}`,
        ).pipe(
          Effect.annotateLogs({
            chainId,
            contractId: lowestState.contractId,
            phase: "sync",
            block: endBlock,
          }),
        );
        yield* syncStore.upsertSyncProgress({
          contractId: lowestState.contractId,
          chainId,
          cursor: null,
          lastBlockHeight: endBlock,
          isComplete: true,
        });
        lowestState.syncedBlockHeight = endBlock;
        lowestState.done = true;
      } else {
        yield* syncStore.upsertSyncProgress({
          contractId: lowestState.contractId,
          chainId,
          cursor: nextCursor,
          lastBlockHeight,
          isComplete: false,
        });
        lowestState.cursor = nextCursor;
      }
    } else {
      yield* Effect.logInfo(`Sync complete for ${lowestState.contractId}`).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: lowestState.contractId,
          phase: "sync",
          block: currentHeight,
        }),
      );
      yield* syncStore.upsertSyncProgress({
        contractId: lowestState.contractId,
        chainId,
        cursor: null,
        lastBlockHeight: currentHeight,
        isComplete: lowestState.endBlock !== undefined,
      });
      lowestState.syncedBlockHeight = currentHeight;
      lowestState.done = true;
    }
  });
}

export const createSync = ({
  chainId,
  client,
  database,
}: {
  chainId: number;
  client: StacksClientService;
  database: IndexerDb;
}): SyncService => ({
  historical: (filters) =>
    Stream.callback<SyncEvent, SyncError>(
      (queue) =>
        Effect.gen(function* () {
          const states = yield* initializeContractStates(filters, chainId);

          yield* Queue.offer(queue, {
            type: "started",
            contracts: states.map(toContractSyncSummary),
          });

          // Fair scheduling: always fetch the contract with the lowest cursor
          // Block height first so a single busy contract cannot starve others.
          while (states.some((state) => !state.done)) {
            let lowestState: ContractSyncState | null = null;
            let lowestHeight = Number.MAX_SAFE_INTEGER;

            for (const state of states) {
              if (!state.done && state.cursor !== null) {
                const height = (yield* parseLogsCursor(state.cursor)).blockHeight;

                if (height < lowestHeight) {
                  lowestHeight = height;
                  lowestState = state;
                }
              }
            }

            // All contracts done
            if (!lowestState || lowestState.cursor === null) {
              break;
            }

            // Fetch one page of events
            const [fetchDuration, logsResponse] = yield* Effect.timed(
              client.getContractLogs(lowestState.contractId, {
                cursor: lowestState.cursor,
              }),
            );

            const fetchDurationMs = Duration.toMillis(fetchDuration);

            yield* Metric.update(syncPages, 1);
            lowestState.pagesFetched = (lowestState.pagesFetched ?? 0) + 1;

            const { results: events, next_cursor: nextCursor } = logsResponse;
            const currentHeight = (yield* parseLogsCursor(lowestState.cursor)).blockHeight;
            yield* Effect.logDebug("Fetched page").pipe(
              Effect.annotateLogs({
                chainId,
                contractId: lowestState.contractId,
                phase: "fetch",
                block: currentHeight,
                events: events.length,
                durationMs: fetchDurationMs,
              }),
            );

            if (fetchDurationMs > SLOW_OPERATION_MILLIS) {
              yield* Effect.logWarning(
                "Fetching contract logs is taking longer than expected",
              ).pipe(
                Effect.annotateLogs({
                  chainId,
                  contractId: lowestState.contractId,
                  phase: "fetch",
                  block: currentHeight,
                  durationMs: fetchDurationMs,
                }),
              );
            }

            // Batch fetch transactions (deduplicated by tx_id) in chronological order
            const txIds = [
              ...new Set(
                events
                  .slice()
                  .reverse()
                  .map((event) => event.tx_id),
              ),
            ];

            const existingTxs = yield* syncStore.getExistingTransactions({ txIds, chainId });

            const existingTxIds = new Set(existingTxs.map((tx) => tx.txId));
            const missingTxIds = txIds.filter((txId) => !existingTxIds.has(txId));

            const [transactionsFetchDuration, transactions] = yield* Effect.timed(
              fetchMissingTransactions(missingTxIds, lowestState.endBlock),
            );

            lowestState.transactionsFetched =
              (lowestState.transactionsFetched ?? 0) + transactions.length;

            yield* Effect.logDebug(
              `Transactions: ${txIds.length} total, ${missingTxIds.length} missing`,
            ).pipe(
              Effect.annotateLogs({
                chainId,
                contractId: lowestState.contractId,
                phase: "fetch",
                durationMs: Duration.toMillis(transactionsFetchDuration),
              }),
            );

            const blocks = extractBlocksFromTransactions(transactions);

            // Store blocks, transactions, and events
            const smartContractLogs = events.filter(
              // oxlint-disable-next-line typescript/no-unnecessary-condition
              (event) => event.event_type === "smart_contract_log",
            );

            const txBlockHeights = new Map<string, number>();

            for (const existingTx of existingTxs) {
              txBlockHeights.set(existingTx.txId, Number(existingTx.blockHeight));
            }

            for (const transaction of transactions) {
              txBlockHeights.set(transaction.tx_id, transaction.block.height);
            }

            const eventsWithBlockHeight = smartContractLogs
              .map((event) => {
                const blockHeight = txBlockHeights.get(event.tx_id) ?? 0;

                return { event, blockHeight };
              })
              .filter((item) => item.blockHeight > 0);

            const [storeDuration] = yield* Effect.timed(
              IndexerDatabase.transaction(() =>
                Effect.all([
                  syncStore.insertBlocks({ blocks, chainId }),
                  syncStore.insertTransactions({ transactions, chainId }),
                  syncStore.insertEvents({ events: eventsWithBlockHeight, chainId }),
                ]),
              ),
            );

            yield* Metric.update(syncEvents, eventsWithBlockHeight.length);
            lowestState.eventsStored =
              (lowestState.eventsStored ?? 0) + eventsWithBlockHeight.length;
            yield* Effect.logDebug("Stored page").pipe(
              Effect.annotateLogs({
                chainId,
                contractId: lowestState.contractId,
                phase: "store",
                block: currentHeight,
                events: eventsWithBlockHeight.length,
                transactions: transactions.length,
                durationMs: Duration.toMillis(storeDuration),
              }),
            );

            yield* advanceContractSyncState(lowestState, currentHeight, nextCursor, chainId);

            // Incremental indexing: notify indexer fiber of current safe block height
            const safeHeight = getSafeBlockHeight(states);

            if (safeHeight !== undefined) {
              yield* Queue.offer(queue, {
                type: "safe",
                safeBlockHeight: safeHeight,
                contracts: states.map(toContractSyncSummary),
              });
            }
          }

          yield* Queue.offer(queue, {
            type: "completed",
            contracts: states.map(toContractSyncSummary),
          });
        }).pipe(
          Effect.provideService(IndexerDatabase, database),
          Effect.provideService(StacksClient, StacksClient.of(client)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Metric.update(syncErrors, 1).pipe(
                  Effect.andThen(Queue.failCause(queue, cause)),
                  Effect.asVoid,
                ),
          ),
          Effect.ensuring(Queue.end(queue).pipe(Effect.asVoid)),
        ),
      // Bound the producer so a slow consumer (handler work, DB contention)
      // Throttles fetching instead of buffering the whole backfill in memory.
      { bufferSize: 1, strategy: "suspend" },
    ),
});

export class Sync extends Context.Service<Sync, SyncService>()("stacksindex/sync/Sync") {
  static readonly layer = ({
    chainId,
  }: {
    chainId: number;
  }): Layer.Layer<Sync, never, StacksClient | IndexerDatabase> =>
    Layer.effect(
      Sync,
      Effect.gen(function* () {
        const client = yield* StacksClient;
        const database = yield* IndexerDatabase;

        return Sync.of(createSync({ chainId, client, database }));
      }),
    );
}
