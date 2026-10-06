import { Context, Effect, Layer, Predicate, Queue, Schema, type LogLevel } from "effect";

import { type DatabaseConfig, IndexerDatabase, migrate } from "../database/index.ts";
import {
  type StacksApiError,
  StacksClient,
  type StorableBlock,
  type StorableTransaction,
} from "../datasources/api/index.ts";
import { Indexing } from "../indexing/index.ts";
import { chunkArray } from "../lib/array.ts";
import {
  ConfigurationError,
  type DatabaseError,
  FilterValidationError,
  type HandlerExecutionError,
  type InvalidCursorError,
  type MigrationError,
  type SyncStoreError,
  TransactionBatchError,
} from "../lib/errors.ts";
import {
  NetworkOptionSchema,
  resolveNetwork,
  type NetworkOption,
  type ResolvedNetwork,
} from "../lib/network.ts";
import type { EventHandler } from "../lib/types.ts";
import { loggerLayer } from "../logger/index.ts";
import { getContractEventsFirstCursor, parseLogsCursor } from "../sync-historical/index.ts";
import { storedEventToHandlerEvent } from "../sync-store/decode.ts";
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

export interface HistoricalRuntimeOptions {
  /** Which chain to index. Defaults to `"mainnet"`. */
  network?: NetworkOption;
  api?: {
    /** Overrides the network's default API endpoint. */
    baseUrl?: string;
    apiKey?: string;
  };
}

export interface HistoricalRuntimeWithDatabaseOptions extends HistoricalRuntimeOptions {
  /** Database used for sync storage and checkpoints. */
  database: DatabaseConfig;
  /** Minimum log level for the pretty console logger. Defaults to `"Info"`. */
  logLevel?: LogLevel.LogLevel;
}

/**
 * Outcome of a single contract sync within a `run`.
 *
 * - `"completed"`: the contract was synced during this run.
 * - `"up-to-date"`: the contract was already fully synced and nothing was fetched.
 */
export interface ContractRunResult {
  contractId: string;
  status: "completed" | "up-to-date";
  startBlock?: number;
  endBlock?: number;
  /** Highest block height fully processed for this contract. */
  lastBlockHeight?: number;
  /** Number of events passed to the contract handler during this run. */
  eventsProcessed: number;
}

export interface RunResult {
  contracts: ContractRunResult[];
  /** Total number of events passed to handlers during this run. */
  eventsProcessed: number;
}

interface ResolvedHistoricalRuntimeConfig {
  chainId: number;
  api: { baseUrl: string; apiKey?: string };
  network: ResolvedNetwork;
}

const HistoricalRuntimeOptionsSchema = Schema.Struct({
  network: Schema.optional(NetworkOptionSchema),
  api: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.optional(Schema.String),
      apiKey: Schema.optional(Schema.String),
    }),
  ),
});

function resolveRuntimeConfig(
  options?: HistoricalRuntimeOptions,
): Effect.Effect<ResolvedHistoricalRuntimeConfig, ConfigurationError> {
  return Schema.decodeUnknownEffect(HistoricalRuntimeOptionsSchema)(options ?? {}).pipe(
    Effect.mapError((error) => new ConfigurationError({ message: error.message })),
    Effect.map((decoded) => {
      const network = resolveNetwork(decoded.network);
      const baseUrl = decoded.api?.baseUrl ?? network.baseUrl;
      const api: ResolvedHistoricalRuntimeConfig["api"] = { baseUrl };

      if (decoded.api?.apiKey !== undefined) {
        api.apiKey = decoded.api.apiKey;
      }

      return {
        network,
        chainId: network.chainId,
        api,
      };
    }),
  );
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

const EventHandlerSchema = Schema.declare<EventHandler>((input): input is EventHandler =>
  Predicate.isFunction(input),
);

const FilterSchema = Schema.Struct({
  contractId: Schema.String,
  handler: EventHandlerSchema,
  startBlock: Schema.optional(Schema.Natural),
  endBlock: Schema.optional(Schema.Union([Schema.Natural, Schema.Literal("latest")])),
}).check(
  Schema.makeFilter((filter) => {
    if (
      filter.startBlock !== undefined &&
      Predicate.isNumber(filter.endBlock) &&
      filter.startBlock > filter.endBlock
    ) {
      return `Start block (${filter.startBlock}) is after end block (${filter.endBlock}) for contract '${filter.contractId}'.`;
    }

    return undefined;
  }),
);

const decodeFilters = Schema.decodeUnknownEffect(Schema.Array(FilterSchema));

function validateAndResolveFilters(
  filters: Filter[],
): Effect.Effect<ResolvedFilter[], StacksApiError | FilterValidationError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;

    const decodedFilters = yield* decodeFilters(filters).pipe(
      Effect.mapError(
        (error) => new FilterValidationError({ message: `Validation failed: ${error.message}` }),
      ),
    );

    let latestBlockHeight: number | undefined = undefined;
    const hasLatestTag = decodedFilters.some((filter) => filter.endBlock === "latest");

    if (hasLatestTag) {
      const status = yield* client.getStatus();
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
      yield* Effect.logInfo(`Resolved "latest" endBlock to block height ${latestBlockHeight}`).pipe(
        Effect.annotateLogs({ latestBlockHeight }),
      );
    }

    const resolvedFilters: ResolvedFilter[] = [];

    for (const filter of decodedFilters) {
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
  config: ResolvedHistoricalRuntimeConfig,
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
      yield* Effect.logInfo(`No events found for ${filter.contractId}, skipping`);
      yield* syncStore.upsertSyncProgress({
        contractId: filter.contractId,
        chainId: config.chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock ?? 0,
        isComplete: filter.endBlock !== undefined,
      });

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock ?? 0,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const cursorHeight = (yield* parseLogsCursor(cursor)).blockHeight;

    if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
      yield* Effect.logInfo(
        `First event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
      );
      yield* syncStore.upsertSyncProgress({
        contractId: filter.contractId,
        chainId: config.chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock,
        isComplete: true,
      });

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    yield* Effect.logInfo(`Starting sync for ${filter.contractId} from block ${cursorHeight}`);

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
  config: ResolvedHistoricalRuntimeConfig,
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
      );

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
      yield* Effect.logInfo(
        `Resumed progress for ${filter.contractId} at block ${savedHeight} exceeds endBlock ${filter.endBlock}, marking done`,
      );

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
      yield* Effect.logInfo(`Resuming sync for ${filter.contractId} from block ${savedHeight}`);

      return {
        contractId: filter.contractId,
        cursor: saved.cursor,
        done: false,
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
        chainId: config.chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock ?? savedHeight,
        isComplete: filter.endBlock !== undefined,
      });

      return {
        contractId: filter.contractId,
        cursor: null,
        syncedBlockHeight: filter.endBlock ?? savedHeight,
        done: true,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      };
    }

    const cursorHeight = (yield* parseLogsCursor(cursor)).blockHeight;

    if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
      yield* Effect.logInfo(
        `Next event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
      );
      yield* syncStore.upsertSyncProgress({
        contractId: filter.contractId,
        chainId: config.chainId,
        cursor: null,
        lastBlockHeight: filter.endBlock,
        isComplete: true,
      });

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
  config: ResolvedHistoricalRuntimeConfig,
): Effect.Effect<
  ContractSyncState[],
  StacksApiError | InvalidCursorError | SyncStoreError,
  StacksClient | IndexerDatabase
> {
  return Effect.gen(function* () {
    const states: ContractSyncState[] = [];

    for (const filter of filters) {
      const saved = yield* syncStore.getSyncProgress({
        contractId: filter.contractId,
        chainId: config.chainId,
      });

      const state =
        saved === null
          ? yield* initContractFromScratch(filter, config)
          : yield* initContractFromSaved(filter, saved, config);

      states.push(state);
    }

    return states;
  });
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
  config: ResolvedHistoricalRuntimeConfig,
): Effect.Effect<void, InvalidCursorError | SyncStoreError, IndexerDatabase> {
  return Effect.gen(function* () {
    lowestState.syncedBlockHeight = currentHeight - 1;

    if (nextCursor) {
      const lastBlockHeight = (yield* parseLogsCursor(nextCursor)).blockHeight;
      const { endBlock } = lowestState;
      const isPastEndBlock = endBlock !== undefined && currentHeight > endBlock;

      if (endBlock !== undefined && isPastEndBlock) {
        yield* Effect.logInfo(`Sync reached endBlock ${endBlock} for ${lowestState.contractId}`);
        yield* syncStore.upsertSyncProgress({
          contractId: lowestState.contractId,
          chainId: config.chainId,
          cursor: null,
          lastBlockHeight: endBlock,
          isComplete: true,
        });
        lowestState.done = true;
      } else {
        yield* syncStore.upsertSyncProgress({
          contractId: lowestState.contractId,
          chainId: config.chainId,
          cursor: nextCursor,
          lastBlockHeight,
          isComplete: false,
        });
        lowestState.cursor = nextCursor;
      }
    } else {
      yield* Effect.logInfo(`Sync complete for ${lowestState.contractId}`);
      yield* syncStore.upsertSyncProgress({
        contractId: lowestState.contractId,
        chainId: config.chainId,
        cursor: null,
        lastBlockHeight: currentHeight,
        isComplete: lowestState.endBlock !== undefined,
      });
      lowestState.done = true;
    }
  });
}

function processEventsUpTo(
  toBlockHeight: number,
  filterMap: Map<string, ResolvedFilter>,
  config: ResolvedHistoricalRuntimeConfig,
  eventsByContract: Map<string, number>,
): Effect.Effect<
  void,
  StacksApiError | HandlerExecutionError | SyncStoreError,
  StacksClient | IndexerDatabase | Indexing
> {
  return Effect.gen(function* () {
    const indexing = yield* Indexing;
    const { chainId } = config;
    const checkpoint = yield* syncStore.getCheckpoint({ chainId });
    const fromBlockHeight = checkpoint ? Number(checkpoint.blockHeight) : 0;

    if (fromBlockHeight >= toBlockHeight) {
      return;
    }

    const rows = yield* syncStore.getEvents({
      chainId,
      fromBlockHeight: fromBlockHeight + 1,
      toBlockHeight,
    });

    if (rows.length === 0) {
      return;
    }

    const toLabel = toBlockHeight === Number.MAX_SAFE_INTEGER ? "latest" : String(toBlockHeight);

    yield* Effect.logInfo(`Indexing events from block ${fromBlockHeight + 1} to ${toLabel}`).pipe(
      Effect.annotateLogs({ count: rows.length }),
    );

    for (const row of rows) {
      const filter = filterMap.get(row.contractId);
      const rowBlockHeight = Number(row.blockHeight);
      const isBeforeStart = filter?.startBlock !== undefined && rowBlockHeight < filter.startBlock;
      const isAfterEnd = filter?.endBlock !== undefined && rowBlockHeight > filter.endBlock;

      if (!isBeforeStart && !isAfterEnd) {
        yield* indexing.executeEvent(storedEventToHandlerEvent(row));
        eventsByContract.set(row.contractId, (eventsByContract.get(row.contractId) ?? 0) + 1);
      }
    }

    const lastRow = rows[rows.length - 1];
    yield* syncStore.upsertCheckpoint({
      chainId,
      blockHeight: Number(lastRow.blockHeight),
      blockTime: Number(lastRow.blockTime),
    });

    yield* Effect.logInfo(
      `Indexed ${rows.length} events up to block ${Number(lastRow.blockHeight)}`,
    ).pipe(Effect.annotateLogs({ block: Number(lastRow.blockHeight) }));
  }).pipe(Effect.withLogSpan("processEventsUpTo"));
}

export type HistoricalRuntimeError =
  | StacksApiError
  | HandlerExecutionError
  | FilterValidationError
  | SyncStoreError
  | TransactionBatchError
  | DatabaseError
  | MigrationError
  | InvalidCursorError;

export interface HistoricalRuntimeService {
  readonly run: (
    filters: Filter[],
  ) => Effect.Effect<RunResult, HistoricalRuntimeError, IndexerDatabase>;
}

export class HistoricalRuntime extends Context.Service<
  HistoricalRuntime,
  HistoricalRuntimeService
>()("stacksindex/runtime/HistoricalRuntime") {
  static readonly layer = (
    options?: HistoricalRuntimeOptions,
  ): Layer.Layer<HistoricalRuntime, ConfigurationError> =>
    Layer.unwrap(
      resolveRuntimeConfig(options).pipe(
        Effect.map((config) =>
          Layer.effect(
            HistoricalRuntime,
            Effect.gen(function* () {
              const client = yield* StacksClient;

              return HistoricalRuntime.of({
                run: (filters) =>
                  runHistorical(filters, config).pipe(Effect.provideService(StacksClient, client)),
              });
            }),
          ).pipe(
            Layer.provide(
              StacksClient.layer({ baseUrl: config.api.baseUrl, apiKey: config.api.apiKey }),
            ),
          ),
        ),
      ),
    );

  /**
   * Batteries-included layer: provides `HistoricalRuntime`, `IndexerDatabase`
   * and the pretty console logger from a single config.
   */
  static readonly layerWithDatabase = (
    options: HistoricalRuntimeWithDatabaseOptions,
  ): Layer.Layer<HistoricalRuntime | IndexerDatabase, ConfigurationError | DatabaseError> =>
    Layer.mergeAll(
      HistoricalRuntime.layer({ network: options.network, api: options.api }),
      IndexerDatabase.layer(options.database),
      loggerLayer({ level: options.logLevel }),
    );
}

function runHistorical(
  filters: Filter[],
  config: ResolvedHistoricalRuntimeConfig,
): Effect.Effect<RunResult, HistoricalRuntimeError, StacksClient | IndexerDatabase> {
  const { chainId } = config;

  const effect = Effect.gen(function* run() {
    if (filters.length === 0) {
      return { contracts: [], eventsProcessed: 0 };
    }

    const resolvedFilters = yield* validateAndResolveFilters(filters);

    yield* migrate();

    yield* Effect.logInfo("Starting historical indexing").pipe(
      Effect.annotateLogs({ contracts: resolvedFilters.map((filter) => filter.contractId) }),
    );

    const filterMap = new Map(resolvedFilters.map((filter) => [filter.contractId, filter]));
    const handlers: Record<string, EventHandler | undefined> = {};

    for (const filter of resolvedFilters) {
      handlers[filter.contractId] = filter.handler;
    }

    const client = yield* StacksClient;

    const states = yield* initializeContractStates(resolvedFilters, config);

    const completedAtStart = new Set(
      states.filter((state) => state.done).map((state) => state.contractId),
    );

    const eventsByContract = new Map<string, number>();

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
        const logsResponse = yield* client.getContractLogs(lowestState.contractId, {
          cursor: lowestState.cursor,
        });

        const { results: events, next_cursor: nextCursor } = logsResponse;
        const currentHeight = (yield* parseLogsCursor(lowestState.cursor)).blockHeight;
        yield* Effect.logInfo(`Syncing ${lowestState.contractId}`).pipe(
          Effect.annotateLogs({ block: currentHeight, events: events.length }),
        );

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
        yield* Effect.logDebug(
          `Transactions: ${txIds.length} total, ${missingTxIds.length} missing`,
        );

        const transactions = yield* fetchMissingTransactions(missingTxIds, lowestState.endBlock);

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

        yield* IndexerDatabase.transaction(() =>
          Effect.all([
            syncStore.insertBlocks({ blocks, chainId }),
            syncStore.insertTransactions({ transactions, chainId }),
            syncStore.insertEvents({ events: eventsWithBlockHeight, chainId }),
          ]),
        );

        yield* advanceContractSyncState(lowestState, currentHeight, nextCursor, config);

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

        yield* processEventsUpTo(nextHeight, filterMap, config, eventsByContract);
      }
    });

    // Run syncer and indexer concurrently with structured interruption
    yield* Effect.all([syncer, indexer], { concurrency: 2 }).pipe(
      Effect.provide(Indexing.layer({ handlers })),
    );

    yield* Effect.logInfo("Historical indexing complete");

    let eventsProcessed = 0;

    const contracts: ContractRunResult[] = states.map((state) => {
      const contractEvents = eventsByContract.get(state.contractId) ?? 0;
      eventsProcessed += contractEvents;

      return {
        contractId: state.contractId,
        status: completedAtStart.has(state.contractId) ? "up-to-date" : "completed",
        startBlock: state.startBlock,
        endBlock: state.endBlock,
        lastBlockHeight: state.syncedBlockHeight,
        eventsProcessed: contractEvents,
      };
    });

    return { contracts, eventsProcessed };
  }).pipe(
    Effect.annotateLogs({ service: "historicalRuntime" }),
    Effect.withLogSpan("historicalIndexing"),
  );

  return effect;
}
