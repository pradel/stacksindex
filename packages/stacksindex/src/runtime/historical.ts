import { Clock, Duration, Effect, Match, Metric, Ref, Schedule, Stream } from "effect";

import { IndexerDatabase } from "../database/index.ts";
import { type StacksApiError, StacksClient } from "../datasources/api/index.ts";
import { Indexing } from "../indexing/index.ts";
import type {
  DatabaseError,
  EventDecodeError,
  FilterValidationError,
  HandlerExecutionError,
  SyncStoreError,
} from "../lib/errors.ts";
import { SLOW_OPERATION_MILLIS } from "../lib/logging.ts";
import {
  chainTipBlock,
  contractAttributes,
  indexingBatchDuration,
  indexingEvents,
  syncBlock,
} from "../lib/metrics.ts";
import type { StoredEvent } from "../sync-store/decode.ts";
import { syncStore } from "../sync-store/index.ts";
import type { ContractSyncSummary, SyncFilter, SyncService } from "../sync/index.ts";
import { chunkEventsByBlock } from "./batches.ts";
import type { IndexerError, ResolvedIndexerConfig } from "./config.ts";
import { type ContractSpec, type ResolvedContract, resolveContracts } from "./contracts.ts";
import {
  computeRunProgress,
  createEtaEstimator,
  logRunProgress,
  PROGRESS_LOG_INTERVAL,
  type ProgressTrackerState,
  recordRunProgress,
} from "./progress.ts";
import { reconcileWithCanonicalChain, recordCheckpointMetrics } from "./reorg.ts";

/** Outcome of one contract within a `run`. */
export interface ContractRunResult {
  /** Number of events passed to the contract's handler during this run. */
  eventsProcessed: number;
  /** Highest block height fully processed for this contract, when known. */
  blockHeight?: number;
}

export interface RunResult {
  /** Total number of events passed to handlers during this run. */
  eventsProcessed: number;
  /** Height through which every event has been indexed. `undefined` before the first batch. */
  blockHeight?: number;
  /** Highest block height considered final after this run. `undefined` before the first batch. */
  finalizedBlockHeight?: number;
  /** Per contract, keyed by definition name. */
  contracts: Record<string, ContractRunResult>;
}

const indexingEventsByContract = new Map<string, typeof indexingEvents>();

/** `indexingEvents` labelled for one contract, built once per contract. */
function contractIndexingEvents(contract: ResolvedContract): typeof indexingEvents {
  const key = `${contract.name}\u0000${contract.contractId}`;
  let metric = indexingEventsByContract.get(key);

  if (metric === undefined) {
    metric = Metric.withAttributes(
      indexingEvents,
      contractAttributes(contract.name, contract.contractId),
    );
    indexingEventsByContract.set(key, metric);
  }

  return metric;
}

/**
 * Indexes one block-aligned batch of stored events together with the new
 * checkpoint, in a single transaction.
 */
function indexBatch(
  batch: StoredEvent[],
  contractsById: Map<string, ResolvedContract>,
  chainId: number,
  eventsByContract: Map<string, number>,
  finalizedBlockHeight: number,
  finalizedBlockTime: number,
): Effect.Effect<
  void,
  HandlerExecutionError | EventDecodeError | SyncStoreError | DatabaseError,
  Indexing | IndexerDatabase
> {
  const lastRow = batch[batch.length - 1];

  const checkpoint = {
    chainId,
    blockHeight: Number(lastRow.blockHeight),
    blockTime: Number(lastRow.blockTime),
    finalizedBlockHeight,
    finalizedBlockTime,
  };

  const inRange = batch.filter((row) => {
    const contract = contractsById.get(row.contractId);
    const rowBlockHeight = Number(row.blockHeight);

    return !(
      (contract?.startBlock !== undefined && rowBlockHeight < contract.startBlock) ||
      (contract?.endBlock !== undefined && rowBlockHeight > contract.endBlock)
    );
  });

  return Effect.gen(function* () {
    const batchEventsByContract = yield* IndexerDatabase.transaction(() =>
      Effect.gen(function* () {
        const indexing = yield* Indexing;
        const counts = yield* indexing.executeBatch(inRange);

        yield* syncStore.upsertCheckpoint(checkpoint);

        return counts;
      }),
    );

    // Counted once committed, so a rolled-back batch is not reported.
    for (const [contractId, count] of batchEventsByContract) {
      eventsByContract.set(contractId, (eventsByContract.get(contractId) ?? 0) + count);
      const contract = contractsById.get(contractId);

      if (contract !== undefined) {
        yield* Metric.update(contractIndexingEvents(contract), count);
      }
    }

    yield* recordCheckpointMetrics(checkpoint);
  });
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
  contractsById: Map<string, ResolvedContract>;
  chainId: number;
  eventsByContract: Map<string, number>;
  finalityThreshold: number;
  finalizedBlockHeight: number;
  finalizedBlockTime: number;
}): Effect.Effect<
  { finalizedBlockHeight: number; finalizedBlockTime: number; indexedDurationMs: number },
  HandlerExecutionError | EventDecodeError | SyncStoreError | DatabaseError,
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
          options.contractsById,
          options.chainId,
          options.eventsByContract,
          finalizedBlockHeight,
          finalizedBlockTime,
        ),
      );

      const batchDurationMs = Duration.toMillis(batchDuration);
      indexedDurationMs += batchDurationMs;

      yield* Metric.update(indexingBatchDuration, batchDurationMs);

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
  contractsById: Map<string, ResolvedContract>,
  chainId: number,
  eventsByContract: Map<string, number>,
  finality: number,
  chainTipHeight: number | undefined,
): Effect.Effect<
  void,
  HandlerExecutionError | EventDecodeError | SyncStoreError | DatabaseError,
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
          const finalizedCheckpoint = {
            chainId,
            blockHeight: checkpointHeight,
            blockTime: Number(checkpoint.blockTime),
            finalizedBlockHeight: checkpointHeight,
            finalizedBlockTime: Number(checkpoint.blockTime),
          };

          yield* syncStore.upsertCheckpoint(finalizedCheckpoint);
          yield* recordCheckpointMetrics(finalizedCheckpoint);
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
      contractsById,
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

/** Per-contract figures of a run, as logged. */
interface ContractRunSummary {
  readonly name: string;
  readonly contractId: string;
  readonly upToDate: boolean;
  readonly startBlock?: number;
  readonly endBlock?: number;
  readonly lastBlockHeight?: number;
  readonly eventsProcessed: number;
  readonly pagesFetched: number;
  readonly transactionsFetched: number;
}

/**
 * Logs the run summary: one `info` line with run totals and block range, then
 * one `debug` line per contract. Unknown bounds are annotated as `null` rather
 * than omitted so the shape is stable.
 */
function logRunSummary(options: {
  chainId: number;
  contracts: readonly ContractRunSummary[];
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
      pagesFetched += contract.pagesFetched;
      transactionsFetched += contract.transactionsFetched;

      if (contract.upToDate) {
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

      yield* Effect.logDebug(`Completed contract ${contract.name}`).pipe(
        Effect.annotateLogs({
          chainId: options.chainId,
          contract: contract.name,
          contractId: contract.contractId,
          phase: "run",
          status: contract.upToDate ? "up-to-date" : "completed",
          startBlock: contract.startBlock ?? null,
          endBlock: contract.endBlock ?? null,
          lastBlockHeight: contract.lastBlockHeight ?? null,
          eventsProcessed: contract.eventsProcessed,
          pagesFetched: contract.pagesFetched,
          transactionsFetched: contract.transactionsFetched,
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
  });
}

/** Contracts resolved once per `run` or `live` call. */
export interface PreparedContracts {
  readonly contracts: readonly ResolvedContract[];
  readonly contractsById: Map<string, ResolvedContract>;
  readonly syncFilters: readonly SyncFilter[];
}

/** Resolves `"latest"` end blocks and indexes the contracts by id. */
export function prepareContracts(
  specs: readonly ContractSpec[],
): Effect.Effect<PreparedContracts, StacksApiError | FilterValidationError, StacksClient> {
  return Effect.gen(function* () {
    const contracts = yield* resolveContracts(specs);

    return {
      contracts,
      contractsById: new Map(contracts.map((contract) => [contract.contractId, contract])),
      syncFilters: contracts.map((contract) => ({
        name: contract.name,
        contractId: contract.contractId,
        startBlock: contract.startBlock,
        endBlock: contract.endBlock,
      })),
    };
  });
}

/** Contracts whose end block is not at or below `blockHeight`. */
export function getSyncingContracts(
  prepared: PreparedContracts,
  blockHeight: number,
): ResolvedContract[] {
  return prepared.contracts.filter(
    (contract) => contract.endBlock === undefined || contract.endBlock >= blockHeight,
  );
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
  readonly prepared: PreparedContracts;
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

    if (tip !== undefined) {
      yield* Metric.update(chainTipBlock, tip.blockHeight);
    }

    const chainTipHeight = tip?.blockHeight;
    const indexingCap = chainTipHeight ?? Number.MAX_SAFE_INTEGER;

    const indexSafeHeight = (safeBlockHeight: number) =>
      indexEventsUpTo(
        Math.min(safeBlockHeight, indexingCap),
        prepared.contractsById,
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

        if (options.logProgress) {
          // The interval logger may last have run before the final pages.
          const { contracts } = yield* Ref.get(progressState);

          if (contracts.length > 0) {
            yield* recordRunProgress(
              computeRunProgress({ contracts, tipBlockHeight: chainTipHeight }),
            );
          }
        }

        // Contracts that finished on their newest logs page, fetched after the
        // Tip was read, have all their events up to the tip stored now. A
        // Contract whose first-event discovery found nothing has not read its
        // Newest page and keeps its height, so the next pass catches it up.
        if (tip !== undefined) {
          const syncingContractIds = new Set(
            getSyncingContracts(prepared, tip.blockHeight).map((contract) => contract.contractId),
          );

          const raisedContracts = completedContracts.filter(
            (contract) => contract.syncedToHead && syncingContractIds.has(contract.contractId),
          );

          yield* syncStore.raiseSyncedBlockHeight({
            chainId,
            contractIds: raisedContracts.map((contract) => contract.contractId),
            blockHeight: tip.blockHeight,
          });

          // The store only raises, so a contract already past the tip keeps its height.
          for (const contract of raisedContracts) {
            const name =
              prepared.contractsById.get(contract.contractId)?.name ?? contract.contractId;

            yield* Metric.update(
              Metric.withAttributes(syncBlock, contractAttributes(name, contract.contractId)),
              Math.max(contract.lastBlockHeight ?? tip.blockHeight, tip.blockHeight),
            );
          }
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
  specs: readonly ContractSpec[],
  config: ResolvedIndexerConfig,
  sync: SyncService,
): Effect.Effect<RunResult, IndexerError, StacksClient | IndexerDatabase> {
  return Effect.gen(function* () {
    const prepared = yield* prepareContracts(specs);

    return yield* runPreparedHistorical(prepared, config, sync);
  });
}

/**
 * Syncs and indexes prepared contracts up to the chain tip read at the start
 * of the pass, then logs and returns the run summary.
 */
export function runPreparedHistorical(
  prepared: PreparedContracts,
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
        contracts: prepared.contracts.map((contract) => contract.name),
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
    }).pipe(Effect.provide(Indexing.layer({ contracts: prepared.contracts })));

    const finalContracts = completedContracts.length > 0 ? completedContracts : startedContracts;

    const syncSummaries = new Map(
      finalContracts.map((contract) => [contract.contractId, contract]),
    );

    let eventsProcessed = 0;
    const contracts: Record<string, ContractRunResult> = {};
    const summaries: ContractRunSummary[] = [];

    for (const contract of prepared.contracts) {
      const summary = syncSummaries.get(contract.contractId);
      const contractEvents = eventsByContract.get(contract.contractId) ?? 0;
      eventsProcessed += contractEvents;

      contracts[contract.name] =
        summary?.lastBlockHeight === undefined
          ? { eventsProcessed: contractEvents }
          : { eventsProcessed: contractEvents, blockHeight: summary.lastBlockHeight };

      summaries.push({
        name: contract.name,
        contractId: contract.contractId,
        upToDate: summary?.doneAtStart ?? false,
        startBlock: summary?.startBlock,
        endBlock: summary?.endBlock,
        lastBlockHeight: summary?.lastBlockHeight,
        eventsProcessed: contractEvents,
        pagesFetched: summary?.pagesFetched ?? 0,
        transactionsFetched: summary?.transactionsFetched ?? 0,
      });
    }

    const finalCheckpoint = yield* syncStore.getCheckpoint({ chainId });
    const blockHeight = finalCheckpoint ? Number(finalCheckpoint.blockHeight) : undefined;

    const finalizedBlockHeight = finalCheckpoint
      ? Number(finalCheckpoint.finalizedBlockHeight)
      : undefined;

    const completedAtMillis = yield* Clock.currentTimeMillis;

    yield* logRunSummary({
      chainId,
      contracts: summaries,
      eventsProcessed,
      finalizedBlockHeight,
      durationMs: completedAtMillis - startedAtMillis,
    });

    return { eventsProcessed, blockHeight, finalizedBlockHeight, contracts };
  }).pipe(Effect.annotateLogs({ service: "indexer" }), Effect.withLogSpan("historicalIndexing"));
}
