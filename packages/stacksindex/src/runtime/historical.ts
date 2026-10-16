import { Clock, Duration, Effect, Match, Metric, Ref, Schedule, Stream } from "effect";

import { IndexerDatabase, migrate } from "../database/index.ts";
import { type StacksApiError, StacksClient } from "../datasources/api/index.ts";
import { Indexing } from "../indexing/index.ts";
import type {
  DatabaseError,
  FilterValidationError,
  HandlerExecutionError,
  MigrationError,
  SyncStoreError,
} from "../lib/errors.ts";
import { SLOW_OPERATION_MILLIS } from "../lib/logging.ts";
import { indexBatchDuration } from "../lib/metrics.ts";
import type { EventHandler, HandlerEvent } from "../lib/types.ts";
import { type StoredEvent, storedEventToHandlerEvent } from "../sync-store/decode.ts";
import { syncStore } from "../sync-store/index.ts";
import type { ContractSyncSummary, SyncFilter, SyncService } from "../sync/index.ts";
import { chunkEventsByBlock } from "./batches.ts";
import type { IndexerError, ResolvedIndexerConfig } from "./config.ts";
import { type Filter, type ResolvedFilter, validateAndResolveFilters } from "./filters.ts";
import {
  createEtaEstimator,
  logRunProgress,
  PROGRESS_LOG_INTERVAL,
  type ProgressTrackerState,
} from "./progress.ts";
import { reconcileWithCanonicalChain } from "./reorg.ts";

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

export interface ChainTip {
  readonly blockHeight: number;
  readonly blockHash: string;
}

/**
 * Reads the chain tip once per run. Falls back to `undefined` (and logs a
 * warning) when the status request or its payload is unavailable: finality
 * lags, indexing is not capped, and the next run cannot verify the stored
 * chain, rather than failing this run.
 */
export function readChainTip(
  chainId: number,
): Effect.Effect<ChainTip | undefined, never, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    const status = yield* client.getStatus();

    const tip = status.chain_tip;

    return tip === undefined || tip === null
      ? undefined
      : { blockHeight: tip.block_height, blockHash: tip.block_hash };
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
export function indexEventsUpTo(
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

/** Filters resolved once per `run` or `live` call. */
export interface PreparedFilters {
  readonly contractIds: readonly string[];
  readonly filterMap: Map<string, ResolvedFilter>;
  readonly handlers: Record<string, EventHandler | undefined>;
  readonly syncFilters: readonly SyncFilter[];
}

/** Validates filters, resolves `"latest"` end blocks and applies pending migrations. */
export function prepareFilters(
  filters: Filter[],
): Effect.Effect<
  PreparedFilters,
  StacksApiError | FilterValidationError | MigrationError,
  StacksClient | IndexerDatabase
> {
  return Effect.gen(function* () {
    const resolvedFilters = yield* validateAndResolveFilters(filters);

    yield* migrate();

    const handlers: Record<string, EventHandler | undefined> = {};

    for (const filter of resolvedFilters) {
      handlers[filter.contractId] = filter.handler;
    }

    return {
      contractIds: resolvedFilters.map((filter) => filter.contractId),
      filterMap: new Map(resolvedFilters.map((filter) => [filter.contractId, filter])),
      handlers,
      syncFilters: resolvedFilters.map((filter) => ({
        contractId: filter.contractId,
        startBlock: filter.startBlock,
        endBlock: filter.endBlock,
      })),
    };
  });
}

/** Contracts whose filter has not ended at or below `blockHeight`. */
export function getSyncingContractIds(prepared: PreparedFilters, blockHeight: number): string[] {
  const contractIds: string[] = [];

  for (const filter of prepared.filterMap.values()) {
    if (filter.endBlock === undefined || filter.endBlock >= blockHeight) {
      contractIds.push(filter.contractId);
    }
  }

  return contractIds;
}

export interface SyncPassResult {
  /** Per-contract snapshots taken before anything was fetched. */
  readonly startedContracts: readonly ContractSyncSummary[];
  /** Per-contract snapshots once every contract is synced. */
  readonly completedContracts: readonly ContractSyncSummary[];
}

/**
 * One sync-and-index pass anchored at `tip`.
 *
 * The previous anchor is verified first (replaying a reorged range), then
 * `tip` becomes the new anchor: nothing above it is indexed, and its hash lets
 * the next pass prove that every stored block below it is still canonical.
 * Every contract's newest events are fetched after the tip was read, so all
 * events up to the tip are stored once the sync ends. Events above it may
 * still be missing for contracts fetched earlier in the pass; indexing them
 * now would move the checkpoint past events that only the next pass stores.
 */
export function syncAndIndexTo(options: {
  readonly chainId: number;
  readonly finality: number;
  readonly sync: SyncService;
  readonly prepared: PreparedFilters;
  /** Chain tip anchoring this pass; `undefined` when it could not be read. */
  readonly tip: ChainTip | undefined;
  /** Per-contract count of events passed to handlers, updated in place. */
  readonly eventsByContract: Map<string, number>;
  /** Logs aggregate progress at `info` while the pass runs. */
  readonly logProgress: boolean;
  /** The caller proved the stored anchor canonical (e.g. `tip` builds on it). */
  readonly anchorIsCanonical?: boolean;
}): Effect.Effect<SyncPassResult, IndexerError, StacksClient | IndexerDatabase | Indexing> {
  const { chainId, tip, prepared } = options;

  return Effect.gen(function* () {
    yield* reconcileWithCanonicalChain(chainId, { anchorIsCanonical: options.anchorIsCanonical });
    // A status payload without a hash cannot anchor the next pass's check.
    yield* syncStore.setSyncAnchor({ chainId, anchor: tip?.blockHash ? tip : null });

    const chainTipHeight = tip?.blockHeight;
    const indexingCap = chainTipHeight ?? Number.MAX_SAFE_INTEGER;

    const indexSafeHeight = (safeBlockHeight: number) =>
      indexEventsUpTo(
        Math.min(safeBlockHeight, indexingCap),
        prepared.filterMap,
        chainId,
        options.eventsByContract,
        options.finality,
        chainTipHeight,
      );

    const progressState = yield* Ref.make<ProgressTrackerState>({ contracts: [] });

    const logProgress = options.logProgress
      ? logRunProgress({
          chainId,
          state: progressState,
          tipBlockHeight: chainTipHeight,
          estimator: createEtaEstimator(),
        })
      : Effect.void;

    let startedContracts: readonly ContractSyncSummary[] = [];
    let completedContracts: readonly ContractSyncSummary[] = [];

    yield* Effect.scoped(
      Effect.gen(function* consumeSyncEvents() {
        // Aggregate progress at info while per-page detail stays at debug. The
        // Fiber stops when the scope closes, i.e. when the stream ends.
        if (options.logProgress) {
          yield* Effect.forkScoped(
            Effect.repeat(logProgress, Schedule.spaced(PROGRESS_LOG_INTERVAL)),
          );
        }

        yield* options.sync.historical(prepared.syncFilters).pipe(
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

        // Contracts that finished on their newest logs page, fetched after the
        // Tip was read, have all their events up to the tip stored now. A
        // Contract whose first-event discovery found nothing has not read its
        // Newest page and keeps its height, so the next pass catches it up.
        if (tip !== undefined) {
          const syncingContractIds = new Set(getSyncingContractIds(prepared, tip.blockHeight));

          yield* syncStore.raiseSyncedBlockHeight({
            chainId,
            contractIds: completedContracts
              .filter(
                (contract) => contract.syncedToHead && syncingContractIds.has(contract.contractId),
              )
              .map((contract) => contract.contractId),
            blockHeight: tip.blockHeight,
          });
        }

        // Final pass: index any remaining stored events (e.g. events from a
        // Contract that finished after the last safe height was emitted).
        yield* indexSafeHeight(indexingCap);
      }),
    );

    return { startedContracts, completedContracts };
  });
}

export function runHistorical(
  filters: Filter[],
  config: ResolvedIndexerConfig,
  sync: SyncService,
): Effect.Effect<RunResult, IndexerError, StacksClient | IndexerDatabase> {
  return Effect.gen(function* () {
    if (filters.length === 0) {
      return { contracts: [], eventsProcessed: 0 };
    }

    const prepared = yield* prepareFilters(filters);

    return yield* runPreparedHistorical(prepared, config, sync);
  });
}

/**
 * Syncs and indexes prepared filters up to the chain tip read at the start of
 * the pass, then logs and returns the run summary.
 */
export function runPreparedHistorical(
  prepared: PreparedFilters,
  config: ResolvedIndexerConfig,
  sync: SyncService,
): Effect.Effect<RunResult, IndexerError, StacksClient | IndexerDatabase> {
  const { chainId } = config;

  return Effect.gen(function* run() {
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const tip = yield* readChainTip(chainId);

    yield* Effect.logInfo("Starting historical indexing").pipe(
      Effect.annotateLogs({
        chainId,
        phase: "run",
        contracts: prepared.contractIds,
        finality: config.finality,
      }),
    );

    const eventsByContract = new Map<string, number>();

    const { startedContracts, completedContracts } = yield* syncAndIndexTo({
      chainId,
      finality: config.finality,
      sync,
      prepared,
      tip,
      eventsByContract,
      logProgress: true,
    }).pipe(Effect.provide(Indexing.layer({ handlers: prepared.handlers })));

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
  }).pipe(Effect.annotateLogs({ service: "indexer" }), Effect.withLogSpan("historicalIndexing"));
}
