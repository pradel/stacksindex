import { Effect, Queue } from "effect";

import { migrate, toThenable, type IndexerDb } from "../database/index.ts";
import { StacksApiUnexpectedError, type StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type DatasourceStacksApiContext,
  type StorableBlock,
  type StorableTransaction,
} from "../datasources/api/index.ts";
import { createIndexing } from "../indexing/index.ts";
import { chunkArray } from "../lib/array.ts";
import {
  FilterValidationError,
  type HandlerExecutionError,
  type SyncStoreError,
} from "../lib/errors.ts";
import { resolveNetwork, type NetworkOption, type ResolvedNetwork } from "../lib/network.ts";
import { startClock } from "../lib/timer.ts";
import type { EventHandler, HandlerEvent } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";
import { createHistoricalSync, parseLogsCursor } from "../sync-historical/index.ts";
import { syncStore } from "../sync-store/index.ts";

/**
 * Max transaction ids per `GET /extended/v3/transactions/batch` call.
 * The API returns summaries for up to 20 mined transactions per request.
 */
const TRANSACTIONS_BATCH_LIMIT = 20;

export interface Filter {
  contractId: string;
  handler: EventHandler;
  startBlock?: number;
  endBlock?: number | "latest";
}

interface ResolvedFilter {
  contractId: string;
  handler: EventHandler;
  startBlock?: number;
  endBlock?: number;
}

// oxlint-disable-next-line typescript/no-explicit-any
export interface HistoricalRuntimeContext<_TSchema extends Record<string, unknown> = any> {
  logger: Logger;
  db: IndexerDb;
  /** Which chain to index. Defaults to `"mainnet"`. */
  network?: NetworkOption;
  api?: {
    /** Overrides the network's default API endpoint. */
    baseUrl?: string;
    apiKey?: string;
  };
}

type ResolvedHistoricalRuntimeContext = Omit<HistoricalRuntimeContext, "network" | "api"> & {
  chainId: number;
  api: { baseUrl: string; apiKey?: string };
  network: ResolvedNetwork;
};

function resolveContext(context: HistoricalRuntimeContext): ResolvedHistoricalRuntimeContext {
  const network = resolveNetwork(context.network);
  const baseUrl = context.api?.baseUrl ?? network.baseUrl;
  return {
    logger: context.logger,
    db: context.db,
    network,
    chainId: network.chainId,
    api: {
      baseUrl,
      ...(context.api?.apiKey === undefined ? {} : { apiKey: context.api.apiKey }),
    },
  };
}

interface ContractSyncState {
  contractId: string;
  cursor: string | null;
  syncedBlockHeight?: number;
  done: boolean;
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

function validateAndResolveFilters(
  filters: Filter[],
  context: DatasourceStacksApiContext,
): Effect.Effect<ResolvedFilter[], StacksApiError | FilterValidationError> {
  return Effect.gen(function* () {
    for (const filter of filters) {
      if (filter.startBlock !== undefined) {
        if (!Number.isInteger(filter.startBlock) || filter.startBlock < 0) {
          return yield* Effect.fail(
            new FilterValidationError({
              message: `Validation failed: Invalid startBlock for '${filter.contractId}'. Got ${filter.startBlock}, expected a non-negative integer.`,
            }),
          );
        }
      }

      if (filter.endBlock !== undefined && filter.endBlock !== "latest") {
        if (!Number.isInteger(filter.endBlock) || filter.endBlock < 0) {
          return yield* Effect.fail(
            new FilterValidationError({
              message: `Validation failed: Invalid endBlock for '${filter.contractId}'. Got ${filter.endBlock}, expected a non-negative integer or "latest".`,
            }),
          );
        }
      }
    }

    let latestBlockHeight: number | undefined = undefined;
    const hasLatestTag = filters.some((filter) => filter.endBlock === "latest");

    if (hasLatestTag) {
      const status = yield* datasourceStacksApi.getStatus(context);
      const chainTipHeight = status.chain_tip?.block_height;
      if (chainTipHeight === undefined) {
        return yield* Effect.fail(
          new FilterValidationError({
            message:
              "Validation failed: Unable to determine latest block height from API status response.",
          }),
        );
      }
      latestBlockHeight = chainTipHeight;
      context.logger?.info({
        service: "historicalRuntime",
        msg: `Resolved "latest" endBlock to block height ${latestBlockHeight}`,
        latestBlockHeight,
      });
    }

    const resolvedFilters: ResolvedFilter[] = [];
    for (const filter of filters) {
      const resolvedEndBlock = filter.endBlock === "latest" ? latestBlockHeight : filter.endBlock;

      if (
        filter.startBlock !== undefined &&
        resolvedEndBlock !== undefined &&
        filter.startBlock > resolvedEndBlock
      ) {
        return yield* Effect.fail(
          new FilterValidationError({
            message: `Validation failed: Start block (${filter.startBlock}) is after end block (${resolvedEndBlock}) for contract '${filter.contractId}'.`,
          }),
        );
      }

      resolvedFilters.push({
        contractId: filter.contractId,
        handler: filter.handler,
        startBlock: filter.startBlock,
        endBlock: resolvedEndBlock,
      });
    }

    return resolvedFilters;
  });
}

function initContractFromScratch(
  filter: ResolvedFilter,
  context: ResolvedHistoricalRuntimeContext,
): Effect.Effect<ContractSyncState, StacksApiError | SyncStoreError> {
  return Effect.gen(function* () {
    const historicalSync = createHistoricalSync(context);
    const cursor = yield* historicalSync.getContractEventsFirstCursor(filter.contractId, {
      startBlock: filter.startBlock,
    });

    if (!cursor) {
      context.logger.info({
        service: "historicalRuntime",
        msg: `No events found for ${filter.contractId}, skipping`,
      });
      yield* syncStore.upsertSyncProgress(
        {
          contractId: filter.contractId,
          chainId: context.chainId,
          cursor: null,
          lastBlockHeight: filter.endBlock ?? 0,
          isComplete: filter.endBlock !== undefined,
        },
        { db: context.db },
      );
      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock ?? 0,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const cursorHeight = parseLogsCursor(cursor).blockHeight;
    if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
      context.logger.info({
        service: "historicalRuntime",
        msg: `First event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
      });
      yield* syncStore.upsertSyncProgress(
        {
          contractId: filter.contractId,
          chainId: context.chainId,
          cursor: null,
          lastBlockHeight: filter.endBlock,
          isComplete: true,
        },
        { db: context.db },
      );
      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    context.logger.info({
      service: "historicalRuntime",
      msg: `Starting sync for ${filter.contractId} from block ${cursorHeight}`,
    });
    return {
      contractId: filter.contractId,
      cursor,
      done: false,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    };
  });
}

function initContractFromSaved(
  filter: ResolvedFilter,
  saved: NonNullable<Effect.Success<ReturnType<typeof syncStore.getSyncProgress>>>,
  context: ResolvedHistoricalRuntimeContext,
): Effect.Effect<ContractSyncState, StacksApiError | SyncStoreError> {
  return Effect.gen(function* () {
    const savedHeight = Number(saved.lastBlockHeight);
    const isAlreadyComplete =
      saved.isComplete && filter.endBlock !== undefined && savedHeight >= filter.endBlock;

    if (isAlreadyComplete) {
      context.logger.info({
        service: "historicalRuntime",
        msg: `Sync already completed for ${filter.contractId} (synced up to block ${savedHeight}), skipping`,
      });
      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: savedHeight,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    if (filter.endBlock !== undefined && savedHeight > filter.endBlock) {
      context.logger.info({
        service: "historicalRuntime",
        msg: `Resumed progress for ${filter.contractId} at block ${savedHeight} exceeds endBlock ${filter.endBlock}, marking done`,
      });
      return {
        contractId: filter.contractId,
        cursor: saved.cursor,
        syncedBlockHeight: savedHeight,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    if (saved.cursor) {
      context.logger.info({
        service: "historicalRuntime",
        msg: `Resuming sync for ${filter.contractId} from block ${savedHeight}`,
      });
      return {
        contractId: filter.contractId,
        cursor: saved.cursor,
        done: false,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const historicalSync = createHistoricalSync(context);
    const cursor = yield* historicalSync.getContractEventsFirstCursor(filter.contractId, {
      startBlock: Math.max(filter.startBlock ?? 0, savedHeight + 1),
    });

    if (!cursor) {
      yield* syncStore.upsertSyncProgress(
        {
          contractId: filter.contractId,
          chainId: context.chainId,
          cursor: null,
          lastBlockHeight: filter.endBlock ?? savedHeight,
          isComplete: filter.endBlock !== undefined,
        },
        { db: context.db },
      );
      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock ?? savedHeight,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const cursorHeight = parseLogsCursor(cursor).blockHeight;
    if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
      context.logger.info({
        service: "historicalRuntime",
        msg: `Next event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
      });
      yield* syncStore.upsertSyncProgress(
        {
          contractId: filter.contractId,
          chainId: context.chainId,
          cursor: null,
          lastBlockHeight: filter.endBlock,
          isComplete: true,
        },
        { db: context.db },
      );
      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    return {
      contractId: filter.contractId,
      cursor,
      done: false,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    };
  });
}

function initializeContractStates(
  filters: ResolvedFilter[],
  context: ResolvedHistoricalRuntimeContext,
): Effect.Effect<ContractSyncState[], StacksApiError | SyncStoreError> {
  return Effect.gen(function* () {
    const states: ContractSyncState[] = [];
    for (const filter of filters) {
      const saved = yield* syncStore.getSyncProgress(
        { contractId: filter.contractId, chainId: context.chainId },
        { db: context.db },
      );

      const state =
        saved === null
          ? yield* initContractFromScratch(filter, context)
          : yield* initContractFromSaved(filter, saved, context);

      states.push(state);
    }
    return states;
  });
}

function fetchChunkViaBatch(
  context: ResolvedHistoricalRuntimeContext,
  chunk: string[],
): Effect.Effect<StorableTransaction[], StacksApiError> {
  return Effect.gen(function* () {
    const batchResponse = yield* datasourceStacksApi.getTransactionsBatch(context, chunk);
    // The batch endpoint returns mined transactions in newest-first
    // Order, not in request order, and omits unknown / mempool
    // Ids instead of erroring. Index by id to restore request order.
    const byId = new Map(batchResponse.results.map((tx) => [tx.tx_id, tx]));
    const missingIds = chunk.filter((txId) => !byId.has(txId));
    if (missingIds.length > 0) {
      return yield* Effect.fail(
        new StacksApiUnexpectedError({
          message: `Batch lookup missed ${missingIds.length} transaction(s): ${missingIds.join(", ")}`,
          cause: { missingIds },
          path: "/extended/v3/transactions/batch",
        }),
      );
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
  context: ResolvedHistoricalRuntimeContext,
  txIds: string[],
  maxBlockHeight?: number,
): Effect.Effect<StorableTransaction[], StacksApiError> {
  return Effect.gen(function* () {
    const transactions: StorableTransaction[] = [];
    for (const chunk of chunkArray(txIds, TRANSACTIONS_BATCH_LIMIT)) {
      const candidates = yield* fetchChunkViaBatch(context, chunk);
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
  context: ResolvedHistoricalRuntimeContext,
): Effect.Effect<void, unknown> {
  return Effect.gen(function* () {
    lowestState.syncedBlockHeight = currentHeight - 1;

    if (nextCursor) {
      const lastBlockHeight = parseLogsCursor(nextCursor).blockHeight;
      const { endBlock } = lowestState;
      const isPastEndBlock = endBlock !== undefined && currentHeight > endBlock;

      if (endBlock !== undefined && isPastEndBlock) {
        context.logger.info({
          service: "historicalRuntime",
          msg: `Sync reached endBlock ${endBlock} for ${lowestState.contractId}`,
        });
        yield* syncStore.upsertSyncProgress(
          {
            contractId: lowestState.contractId,
            chainId: context.chainId,
            cursor: null,
            lastBlockHeight: endBlock,
            isComplete: true,
          },
          { db: context.db },
        );
        lowestState.done = true;
      } else {
        yield* syncStore.upsertSyncProgress(
          {
            contractId: lowestState.contractId,
            chainId: context.chainId,
            cursor: nextCursor,
            lastBlockHeight,
            isComplete: false,
          },
          { db: context.db },
        );
        lowestState.cursor = nextCursor;
      }
    } else {
      context.logger.info({
        service: "historicalRuntime",
        msg: `Sync complete for ${lowestState.contractId}`,
      });
      yield* syncStore.upsertSyncProgress(
        {
          contractId: lowestState.contractId,
          chainId: context.chainId,
          cursor: null,
          lastBlockHeight: currentHeight,
          isComplete: lowestState.endBlock !== undefined,
        },
        { db: context.db },
      );
      lowestState.done = true;
    }
  });
}

function processEventsUpTo(
  toBlockHeight: number,
  indexing: ReturnType<typeof createIndexing>,
  filterMap: Map<string, ResolvedFilter>,
  context: ResolvedHistoricalRuntimeContext,
): Effect.Effect<void, StacksApiError | HandlerExecutionError | SyncStoreError> {
  return Effect.gen(function* () {
    const { chainId } = context;
    const checkpoint = yield* syncStore.getCheckpoint({ chainId }, { db: context.db });
    const fromBlockHeight = checkpoint ? Number(checkpoint.blockHeight) : 0;

    if (fromBlockHeight >= toBlockHeight) {
      return;
    }

    const rows = yield* syncStore.getEvents(
      { chainId, fromBlockHeight: fromBlockHeight + 1, toBlockHeight },
      { db: context.db },
    );

    if (rows.length === 0) {
      return;
    }

    const toLabel = toBlockHeight === Number.MAX_SAFE_INTEGER ? "latest" : String(toBlockHeight);
    context.logger.info({
      service: "historicalRuntime",
      msg: `Indexing events from block ${fromBlockHeight + 1} to ${toLabel}`,
      count: rows.length,
    });

    const batchClock = startClock();

    for (const row of rows) {
      const filter = filterMap.get(row.contractId);
      const rowBlockHeight = Number(row.blockHeight);
      const isBeforeStart = filter?.startBlock !== undefined && rowBlockHeight < filter.startBlock;
      const isAfterEnd = filter?.endBlock !== undefined && rowBlockHeight > filter.endBlock;

      if (!isBeforeStart && !isAfterEnd) {
        const event: HandlerEvent = {
          event_index: row.eventIndex,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          event_type: row.eventType as "smart_contract_log",
          tx_id: row.txId,
          contract_log: {
            contract_id: row.contractId,
            topic: row.topic ?? "",
            value: {
              hex: row.valueHex,
              repr: row.valueRepr,
            },
          },
          block_height: rowBlockHeight,
          block_time: Number(row.blockTime),
          tx_index: row.txIndex,
          sender_address: row.senderAddress,
        };
        yield* indexing.executeEvent(event);
      }
    }

    const lastRow = rows[rows.length - 1];
    yield* syncStore.upsertCheckpoint(
      {
        chainId,
        blockHeight: Number(lastRow.blockHeight),
        blockTime: Number(lastRow.blockTime),
      },
      { db: context.db },
    );

    const batchDuration = batchClock();
    context.logger.info({
      service: "historicalRuntime",
      msg: `Indexed ${rows.length} events up to block ${Number(lastRow.blockHeight)}`,
      block: Number(lastRow.blockHeight),
      duration: batchDuration,
    });
  });
}

export const createHistoricalRuntime = (input: HistoricalRuntimeContext) => {
  const context = resolveContext(input);
  const { chainId } = context;

  return {
    run(
      filters: Filter[],
    ): Effect.Effect<
      void,
      StacksApiError | HandlerExecutionError | FilterValidationError | SyncStoreError
    > &
      PromiseLike<void> {
      const effect = Effect.gen(function* run() {
        if (filters.length === 0) {
          return;
        }

        const resolvedFilters = yield* validateAndResolveFilters(filters, context);

        yield* migrate(context.db);

        const runClock = startClock();
        context.logger.info({
          service: "historicalRuntime",
          msg: "Starting historical indexing",
          contracts: resolvedFilters.map((filter) => filter.contractId),
        });

        const filterMap = new Map(resolvedFilters.map((filter) => [filter.contractId, filter]));
        const handlers: Record<string, EventHandler | undefined> = {};
        for (const filter of resolvedFilters) {
          handlers[filter.contractId] = filter.handler;
        }
        const indexing = createIndexing({
          logger: context.logger,
          db: context.db,
          handlers,
          api: context.api,
        });

        const states = yield* initializeContractStates(resolvedFilters, context);

        // Coordination queue between Syncer fiber and Indexer fiber
        // Queue transmits safe block heights to process (null signals completion)
        const heightQueue = yield* Queue.unbounded<number | null>();

        // Syncer fiber: fetches blocks, transactions, and events concurrently
        const syncer = Effect.gen(function* syncer() {
          while (states.some((state) => !state.done)) {
            // Fair scheduling: find contract with lowest cursor block height
            let lowestState: ContractSyncState | null = null;
            let lowestHeight = Number.MAX_SAFE_INTEGER;

            for (const state of states) {
              if (!state.done && state.cursor !== null) {
                const height = parseLogsCursor(state.cursor).blockHeight;
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
            const logsResponse = yield* datasourceStacksApi.getContractLogs(
              context,
              lowestState.contractId,
              { cursor: lowestState.cursor },
            );

            const { results: events, next_cursor: nextCursor } = logsResponse;
            const currentHeight = parseLogsCursor(lowestState.cursor).blockHeight;
            context.logger.info({
              service: "historicalRuntime",
              msg: `Syncing ${lowestState.contractId}`,
              block: currentHeight,
              events: events.length,
            });

            // Batch fetch transactions (deduplicated by tx_id) in chronological order
            const txIds = [
              ...new Set(
                events
                  .slice()
                  .reverse()
                  .map((event) => event.tx_id),
              ),
            ];
            const existingTxs = yield* syncStore.getExistingTransactions(
              { txIds, chainId },
              { db: context.db },
            );
            const existingTxIds = new Set(existingTxs.map((tx) => tx.txId));
            const missingTxIds = txIds.filter((txId) => !existingTxIds.has(txId));
            context.logger.debug({
              service: "historicalRuntime",
              msg: `Transactions: ${txIds.length} total, ${missingTxIds.length} missing`,
            });

            const transactions = yield* fetchMissingTransactions(
              context,
              missingTxIds,
              lowestState.endBlock,
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

            yield* context.db.transaction((tx) =>
              Effect.all([
                syncStore.insertBlocks({ blocks, chainId }, { db: tx }),
                syncStore.insertTransactions({ transactions, chainId }, { db: tx }),
                syncStore.insertEvents({ events: eventsWithBlockHeight, chainId }, { db: tx }),
              ]),
            );

            yield* advanceContractSyncState(lowestState, currentHeight, nextCursor, context);

            // Incremental indexing: notify indexer fiber of current safe block height
            const safeHeight = getSafeBlockHeight(states);
            if (safeHeight !== undefined) {
              yield* Queue.offer(heightQueue, safeHeight);
            }
          }

          // Syncer finished: signal indexer to do final pass and finish
          yield* Queue.offer(heightQueue, Number.MAX_SAFE_INTEGER);
          yield* Queue.offer(heightQueue, null);
        });

        // Indexer fiber: consumes safe block heights and indexes events transactionally
        const indexer = Effect.gen(function* indexer() {
          while (true) {
            const nextHeight = yield* Queue.take(heightQueue);
            if (nextHeight === null) {
              break;
            }
            yield* processEventsUpTo(nextHeight, indexing, filterMap, context);
          }
        });

        // Run syncer and indexer concurrently with structured interruption
        yield* Effect.all([syncer, indexer], { concurrency: 2 });

        const runDuration = runClock();
        context.logger.info({
          service: "historicalRuntime",
          msg: "Historical indexing complete",
          duration: runDuration,
        });
      });

      return toThenable(effect) as Effect.Effect<
        void,
        StacksApiError | HandlerExecutionError | FilterValidationError | SyncStoreError
      > &
        PromiseLike<void>;
    },
  };
};
