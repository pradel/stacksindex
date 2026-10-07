import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Metric,
  Ref,
  Schedule,
  Schema,
  Stream,
  type LogLevel,
} from "effect";

import { type DatabaseConfig, IndexerDatabase, migrate } from "../database/index.ts";
import { type StacksApiError, StacksClient } from "../datasources/api/index.ts";
import { Indexing } from "../indexing/index.ts";
import {
  ConfigurationError,
  type DatabaseError,
  type FilterValidationError,
  type HandlerExecutionError,
  type InvalidCursorError,
  type MigrationError,
  type SyncStoreError,
  type TransactionBatchError,
} from "../lib/errors.ts";
import { SLOW_OPERATION_MILLIS } from "../lib/logging.ts";
import { indexBatchDuration } from "../lib/metrics.ts";
import {
  NetworkOptionSchema,
  resolveNetwork,
  type NetworkOption,
  type ResolvedNetwork,
} from "../lib/network.ts";
import type { EventHandler, HandlerEvent } from "../lib/types.ts";
import { loggerLayer } from "../logger/index.ts";
import { type StoredEvent, storedEventToHandlerEvent } from "../sync-store/decode.ts";
import { syncStore } from "../sync-store/index.ts";
import {
  type ContractSyncSummary,
  Sync,
  type SyncFilter,
  type SyncService,
} from "../sync/index.ts";
import { chunkEventsByBlock } from "./batches.ts";
import { type Filter, type ResolvedFilter, validateAndResolveFilters } from "./filters.ts";
import {
  createEtaEstimator,
  logRunProgress,
  PROGRESS_LOG_INTERVAL,
  type ProgressTrackerState,
} from "./progress.ts";

export type { Filter } from "./filters.ts";

export interface HistoricalRuntimeOptions {
  /** Which chain to index. Defaults to `"mainnet"`. */
  network?: NetworkOption;
  api?: {
    /** Overrides the network's default API endpoint. */
    baseUrl?: string;
    apiKey?: string;
  };
  /**
   * Number of blocks kept unfinalized behind the indexed height. Defaults to
   * `0` (everything indexed is immediately finalized).
   */
  finality?: number;
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
  /** Number of contract-log pages fetched for this contract during the run. */
  pagesFetched?: number;
  /** Number of transactions fetched for this contract during the run. */
  transactionsFetched?: number;
}

export interface RunResult {
  contracts: ContractRunResult[];
  /** Total number of events passed to handlers during this run. */
  eventsProcessed: number;
  /**
   * Highest block height considered final after this run. `undefined` when no
   * checkpoint exists yet.
   */
  finalizedBlockHeight?: number;
}

interface ResolvedHistoricalRuntimeConfig {
  chainId: number;
  api: { baseUrl: string; apiKey?: string };
  network: ResolvedNetwork;
  finality: number;
}

const HistoricalRuntimeOptionsSchema = Schema.Struct({
  network: Schema.optional(NetworkOptionSchema),
  api: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.optional(Schema.String),
      apiKey: Schema.optional(Schema.String),
    }),
  ),
  finality: Schema.optional(Schema.Natural),
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
        finality: decoded.finality ?? 0,
      };
    }),
  );
}

/**
 * Indexes one block-aligned batch of stored events together with the new
 * checkpoint, in a single transaction.
 */
function indexBatch(
  batch: StoredEvent[],
  filterMap: Map<string, ResolvedFilter>,
  chainId: number,
  eventsByContract: Map<string, number>,
  finalizedBlockHeight: number,
  finalizedBlockTime: number,
): Effect.Effect<
  void,
  HandlerExecutionError | SyncStoreError | DatabaseError,
  Indexing | IndexerDatabase
> {
  return IndexerDatabase.transaction(() =>
    Effect.gen(function* () {
      const indexing = yield* Indexing;
      const events: HandlerEvent[] = [];

      for (const row of batch) {
        const filter = filterMap.get(row.contractId);
        const rowBlockHeight = Number(row.blockHeight);

        const isBeforeStart =
          filter?.startBlock !== undefined && rowBlockHeight < filter.startBlock;

        const isAfterEnd = filter?.endBlock !== undefined && rowBlockHeight > filter.endBlock;

        if (!isBeforeStart && !isAfterEnd) {
          events.push(storedEventToHandlerEvent(row));
          eventsByContract.set(row.contractId, (eventsByContract.get(row.contractId) ?? 0) + 1);
        }
      }

      yield* indexing.executeBatch(events);

      const lastRow = batch[batch.length - 1];
      yield* syncStore.upsertCheckpoint({
        chainId,
        blockHeight: Number(lastRow.blockHeight),
        blockTime: Number(lastRow.blockTime),
        finalizedBlockHeight,
        finalizedBlockTime,
      });
    }),
  );
}

/**
 * Reads the chain tip height once per run, when a finality window is
 * configured. Falls back to `undefined` (and logs a warning) when the status
 * request or its payload is unavailable, so finality lags rather than failing
 * the run.
 */
function readChainTipHeight(
  chainId: number,
): Effect.Effect<number | undefined, never, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    const status = yield* client.getStatus();

    return status.chain_tip?.block_height;
  }).pipe(
    Effect.tapError((error) =>
      Effect.logWarning("Failed to read the chain tip; finality may lag behind").pipe(
        Effect.annotateLogs({ chainId, phase: "fetch", error: String(error) }),
      ),
    ),
    Effect.orElseSucceed(() => undefined),
  );
}

/**
 * Indexes block-aligned batches in order, advancing the finalized marker as
 * batches become deep enough. Times every batch, records the histogram, and
 * warns when one takes longer than expected.
 */
function indexBatches(options: {
  batches: StoredEvent[][];
  filterMap: Map<string, ResolvedFilter>;
  chainId: number;
  eventsByContract: Map<string, number>;
  finalityThreshold: number;
  finalizedBlockHeight: number;
  finalizedBlockTime: number;
}): Effect.Effect<
  { finalizedBlockHeight: number; finalizedBlockTime: number; indexedDurationMs: number },
  HandlerExecutionError | SyncStoreError | DatabaseError,
  Indexing | IndexerDatabase
> {
  return Effect.gen(function* () {
    let { finalizedBlockHeight } = options;
    let { finalizedBlockTime } = options;
    let indexedDurationMs = 0;

    for (const batch of options.batches) {
      const finalizableRow = batch.findLast(
        (row) => Number(row.blockHeight) <= options.finalityThreshold,
      );

      if (
        finalizableRow !== undefined &&
        Number(finalizableRow.blockHeight) > finalizedBlockHeight
      ) {
        finalizedBlockHeight = Number(finalizableRow.blockHeight);
        finalizedBlockTime = Number(finalizableRow.blockTime);
      }

      const [batchDuration] = yield* Effect.timed(
        indexBatch(
          batch,
          options.filterMap,
          options.chainId,
          options.eventsByContract,
          finalizedBlockHeight,
          finalizedBlockTime,
        ),
      );

      const batchDurationMs = Duration.toMillis(batchDuration);
      indexedDurationMs += batchDurationMs;

      yield* Metric.update(indexBatchDuration, batchDurationMs);

      const lastBatchRow = batch[batch.length - 1];

      if (batchDurationMs > SLOW_OPERATION_MILLIS && lastBatchRow !== undefined) {
        yield* Effect.logWarning("Indexing events is taking longer than expected").pipe(
          Effect.annotateLogs({
            chainId: options.chainId,
            phase: "index",
            block: Number(lastBatchRow.blockHeight),
            events: batch.length,
            durationMs: batchDurationMs,
          }),
        );
      }
    }

    return { finalizedBlockHeight, finalizedBlockTime, indexedDurationMs };
  });
}

/**
 * Indexes every stored event with height `> checkpoint` and `<= toBlockHeight`.
 * Events are split into block-aligned batches so each transaction stays
 * bounded and every checkpoint refers to a fully processed block.
 *
 * The finalized marker advances to the newest committed block that is at least
 * `finality` blocks behind the confirmation height. The confirmation height is
 * the chain tip when it was read for the run, capped by the safe height during
 * incremental steps; without a tip it falls back to the newest stored
 * event-bearing block on the final `MAX_SAFE_INTEGER` pass. It never refers to
 * data that is not yet committed.
 */
function indexEventsUpTo(
  toBlockHeight: number,
  filterMap: Map<string, ResolvedFilter>,
  chainId: number,
  eventsByContract: Map<string, number>,
  finality: number,
  chainTipHeight: number | undefined,
): Effect.Effect<
  void,
  HandlerExecutionError | SyncStoreError | DatabaseError,
  Indexing | IndexerDatabase
> {
  return Effect.gen(function* () {
    const checkpoint = yield* syncStore.getCheckpoint({ chainId });
    const fromBlockHeight = checkpoint ? Number(checkpoint.blockHeight) : 0;

    if (fromBlockHeight >= toBlockHeight) {
      return;
    }

    const confirmationHeight =
      toBlockHeight === Number.MAX_SAFE_INTEGER
        ? chainTipHeight
        : Math.min(toBlockHeight, chainTipHeight ?? toBlockHeight);

    const rows = yield* syncStore.getEvents({
      chainId,
      fromBlockHeight: fromBlockHeight + 1,
      toBlockHeight,
    });

    if (rows.length === 0) {
      // No new events, but the existing checkpoint block can still become
      // Final now that the chain has advanced. Confirm it when it is at least
      // `finality` blocks behind the confirmation height.
      if (checkpoint !== null && confirmationHeight !== undefined) {
        const checkpointHeight = Number(checkpoint.blockHeight);
        const checkpointFinalizedHeight = Number(checkpoint.finalizedBlockHeight);

        if (
          checkpointHeight <= confirmationHeight - finality &&
          checkpointHeight > checkpointFinalizedHeight
        ) {
          yield* syncStore.upsertCheckpoint({
            chainId,
            blockHeight: checkpointHeight,
            blockTime: Number(checkpoint.blockTime),
            finalizedBlockHeight: checkpointHeight,
            finalizedBlockTime: Number(checkpoint.blockTime),
          });
        }
      }

      return;
    }

    const batches = chunkEventsByBlock(rows);
    const toLabel = toBlockHeight === Number.MAX_SAFE_INTEGER ? "latest" : String(toBlockHeight);

    yield* Effect.logDebug(`Indexing events from block ${fromBlockHeight + 1} to ${toLabel}`).pipe(
      Effect.annotateLogs({
        chainId,
        phase: "index",
        blockRange: [fromBlockHeight + 1, toLabel],
        count: rows.length,
        batches: batches.length,
        finality,
      }),
    );

    const rangeEndHeight = Number(rows[rows.length - 1].blockHeight);
    const finalityThreshold = (confirmationHeight ?? rangeEndHeight) - finality;

    let finalizedBlockHeight = checkpoint ? Number(checkpoint.finalizedBlockHeight) : 0;
    let finalizedBlockTime = checkpoint ? Number(checkpoint.finalizedBlockTime) : 0;

    // The checkpoint block is not part of `rows` (they start above it), but it
    // May already be deep enough to finalize.
    if (checkpoint !== null) {
      const checkpointHeight = Number(checkpoint.blockHeight);

      if (checkpointHeight <= finalityThreshold && checkpointHeight > finalizedBlockHeight) {
        finalizedBlockHeight = checkpointHeight;
        finalizedBlockTime = Number(checkpoint.blockTime);
      }
    }

    const {
      finalizedBlockHeight: nextFinalizedBlockHeight,
      finalizedBlockTime: nextFinalizedBlockTime,
      indexedDurationMs,
    } = yield* indexBatches({
      batches,
      filterMap,
      chainId,
      eventsByContract,
      finalityThreshold,
      finalizedBlockHeight,
      finalizedBlockTime,
    });

    finalizedBlockHeight = nextFinalizedBlockHeight;
    finalizedBlockTime = nextFinalizedBlockTime;

    const lastRow = rows[rows.length - 1];
    yield* Effect.logDebug(
      `Indexed ${rows.length} events up to block ${Number(lastRow.blockHeight)}`,
    ).pipe(
      Effect.annotateLogs({
        chainId,
        phase: "checkpoint",
        block: Number(lastRow.blockHeight),
        events: rows.length,
        durationMs: indexedDurationMs,
        finalizedBlockHeight,
        finalizedBlockTime,
      }),
    );
  });
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

/**
 * Logs the run summary: one `info` line with run totals and block range, then
 * one `debug` line per contract. Unknown bounds are annotated as `null` rather
 * than omitted so the shape is stable.
 */
function logRunSummary(options: {
  chainId: number;
  contracts: readonly ContractRunResult[];
  eventsProcessed: number;
  finalizedBlockHeight: number | undefined;
  durationMs: number;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    let pagesFetched = 0;
    let transactionsFetched = 0;
    let upToDate = 0;
    let fromBlock: number | undefined = undefined;
    let toBlock: number | undefined = undefined;

    for (const contract of options.contracts) {
      pagesFetched += contract.pagesFetched ?? 0;
      transactionsFetched += contract.transactionsFetched ?? 0;

      if (contract.status === "up-to-date") {
        upToDate += 1;
      }

      const lower = contract.startBlock ?? contract.lastBlockHeight;
      const upper = contract.endBlock ?? contract.lastBlockHeight;

      if (lower !== undefined) {
        fromBlock = fromBlock === undefined ? lower : Math.min(fromBlock, lower);
      }

      if (upper !== undefined) {
        toBlock = toBlock === undefined ? upper : Math.max(toBlock, upper);
      }

      yield* Effect.logDebug(`Completed contract ${contract.contractId}`).pipe(
        Effect.annotateLogs({
          chainId: options.chainId,
          contractId: contract.contractId,
          phase: "run",
          status: contract.status,
          startBlock: contract.startBlock ?? null,
          endBlock: contract.endBlock ?? null,
          lastBlockHeight: contract.lastBlockHeight ?? null,
          eventsProcessed: contract.eventsProcessed,
          pagesFetched: contract.pagesFetched ?? 0,
          transactionsFetched: contract.transactionsFetched ?? 0,
        }),
      );
    }

    yield* Effect.logInfo("Historical indexing complete").pipe(
      Effect.annotateLogs({
        chainId: options.chainId,
        phase: "run",
        durationMs: options.durationMs,
        contracts: options.contracts.length,
        upToDate,
        eventsProcessed: options.eventsProcessed,
        pagesFetched,
        transactionsFetched,
        fromBlock: fromBlock ?? null,
        toBlock: toBlock ?? null,
        finalizedBlockHeight: options.finalizedBlockHeight ?? null,
      }),
    );

    if (options.contracts.length === 0) {
      yield* Effect.logWarning("Historical indexing completed with no contracts").pipe(
        Effect.annotateLogs({ chainId: options.chainId, phase: "run" }),
      );
    }
  });
}

export interface HistoricalRuntimeService {
  readonly run: (filters: Filter[]) => Effect.Effect<RunResult, HistoricalRuntimeError>;
}

export class HistoricalRuntime extends Context.Service<
  HistoricalRuntime,
  HistoricalRuntimeService
>()("stacksindex/runtime/HistoricalRuntime") {
  static readonly layer = (
    options?: HistoricalRuntimeOptions,
  ): Layer.Layer<HistoricalRuntime, ConfigurationError, IndexerDatabase> =>
    Layer.unwrap(
      resolveRuntimeConfig(options).pipe(
        Effect.map((config) =>
          Layer.effect(
            HistoricalRuntime,
            Effect.gen(function* () {
              const sync = yield* Sync;
              const client = yield* StacksClient;
              const database = yield* IndexerDatabase;

              return HistoricalRuntime.of({
                run: (filters) =>
                  runHistorical(filters, config, sync).pipe(
                    Effect.provideService(StacksClient, client),
                    Effect.provideService(IndexerDatabase, database),
                  ),
              });
            }),
          ).pipe(
            Layer.provide(Sync.layer({ chainId: config.chainId })),
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
      HistoricalRuntime.layer({
        network: options.network,
        api: options.api,
        finality: options.finality,
      }).pipe(Layer.provideMerge(IndexerDatabase.layer(options.database))),
      loggerLayer({ level: options.logLevel }),
    );
}

function runHistorical(
  filters: Filter[],
  config: ResolvedHistoricalRuntimeConfig,
  sync: SyncService,
): Effect.Effect<RunResult, HistoricalRuntimeError, StacksClient | IndexerDatabase> {
  const { chainId } = config;

  const effect = Effect.gen(function* run() {
    if (filters.length === 0) {
      return { contracts: [], eventsProcessed: 0 };
    }

    const startedAtMillis = yield* Clock.currentTimeMillis;

    const resolvedFilters = yield* validateAndResolveFilters(filters);

    yield* migrate();

    // Unfinalized data is provisional across restarts: it may belong to a fork
    // That was orphaned while the process was down. Discard it and let the
    // Normal sync/index pass refetch and replay the canonical chain.
    const rewind = yield* syncStore.rewindToFinalized({ chainId });

    if (rewind !== null) {
      yield* Effect.logWarning(
        `Discarded unfinalized data from block ${rewind.fromBlockHeight}; refetching from block ${rewind.toBlockHeight + 1}`,
      ).pipe(Effect.annotateLogs({ chainId, phase: "init", ...rewind }));
    }

    // Finality is measured against the chain tip when a finality window is
    // Configured. The tip is also the progress target for open-ended filters,
    // So it is read whenever either needs it. Reading it once per run keeps the
    // Final pass accurate even when no events were stored near the tip.
    const needsChainTip =
      config.finality > 0 || resolvedFilters.some((filter) => filter.endBlock === undefined);

    const chainTipHeight = needsChainTip ? yield* readChainTipHeight(chainId) : undefined;

    yield* Effect.logInfo("Starting historical indexing").pipe(
      Effect.annotateLogs({
        chainId,
        phase: "run",
        contracts: resolvedFilters.map((filter) => filter.contractId),
        finality: config.finality,
      }),
    );

    const filterMap = new Map(resolvedFilters.map((filter) => [filter.contractId, filter]));
    const handlers: Record<string, EventHandler | undefined> = {};

    for (const filter of resolvedFilters) {
      handlers[filter.contractId] = filter.handler;
    }

    const syncFilters: SyncFilter[] = resolvedFilters.map((filter) => ({
      contractId: filter.contractId,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    }));

    const eventsByContract = new Map<string, number>();

    let startedContracts: readonly ContractSyncSummary[] = [];
    let completedContracts: readonly ContractSyncSummary[] = [];

    const indexSafeHeight = (safeBlockHeight: number) =>
      indexEventsUpTo(
        safeBlockHeight,
        filterMap,
        chainId,
        eventsByContract,
        config.finality,
        chainTipHeight,
      );

    const progressState = yield* Ref.make<ProgressTrackerState>({ contracts: [] });

    const logProgress = logRunProgress({
      chainId,
      state: progressState,
      tipBlockHeight: chainTipHeight,
      estimator: createEtaEstimator(),
    });

    yield* Effect.scoped(
      Effect.gen(function* consumeSyncEvents() {
        // Aggregate progress at info while per-page detail stays at debug. The
        // Fiber stops when the run scope closes, i.e. when the stream ends.
        yield* Effect.forkScoped(
          Effect.repeat(logProgress, Schedule.spaced(PROGRESS_LOG_INTERVAL)),
        );

        yield* sync.historical(syncFilters).pipe(
          Stream.runForEach((event) =>
            Match.value(event).pipe(
              Match.when({ type: "started" }, (started) =>
                Effect.gen(function* () {
                  startedContracts = started.contracts;
                  yield* Ref.set(progressState, { contracts: started.contracts });
                  // First progress line: the already-synced fraction.
                  yield* logProgress;
                }),
              ),
              Match.when({ type: "safe" }, (safe) =>
                Effect.gen(function* () {
                  yield* Ref.set(progressState, {
                    contracts: safe.contracts,
                    safeBlockHeight: safe.safeBlockHeight,
                  });
                  yield* indexSafeHeight(safe.safeBlockHeight);
                }),
              ),
              Match.when({ type: "completed" }, (completed) =>
                Effect.gen(function* () {
                  completedContracts = completed.contracts;
                  yield* Ref.set(progressState, { contracts: completed.contracts });
                }),
              ),
              Match.exhaustive,
            ),
          ),
        );

        // Final pass: index any remaining stored events (e.g. events from a
        // Contract that finished after the last safe height was emitted).
        yield* indexSafeHeight(Number.MAX_SAFE_INTEGER);
      }).pipe(Effect.provide(Indexing.layer({ handlers }))),
    );

    const finalContracts = completedContracts.length > 0 ? completedContracts : startedContracts;
    let eventsProcessed = 0;

    const contracts: ContractRunResult[] = finalContracts.map((contract) => {
      const contractEvents = eventsByContract.get(contract.contractId) ?? 0;
      eventsProcessed += contractEvents;

      return {
        contractId: contract.contractId,
        status: contract.doneAtStart ? "up-to-date" : "completed",
        startBlock: contract.startBlock,
        endBlock: contract.endBlock,
        lastBlockHeight: contract.lastBlockHeight,
        eventsProcessed: contractEvents,
        pagesFetched: contract.pagesFetched,
        transactionsFetched: contract.transactionsFetched,
      };
    });

    const finalCheckpoint = yield* syncStore.getCheckpoint({ chainId });

    const finalizedBlockHeight = finalCheckpoint
      ? Number(finalCheckpoint.finalizedBlockHeight)
      : undefined;

    const completedAtMillis = yield* Clock.currentTimeMillis;

    yield* logRunSummary({
      chainId,
      contracts,
      eventsProcessed,
      finalizedBlockHeight,
      durationMs: completedAtMillis - startedAtMillis,
    });

    return { contracts, eventsProcessed, finalizedBlockHeight };
  }).pipe(
    Effect.annotateLogs({ service: "historicalRuntime" }),
    Effect.withLogSpan("historicalIndexing"),
  );

  return effect;
}
