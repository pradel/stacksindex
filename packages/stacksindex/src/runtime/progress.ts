import { Clock, Duration, Effect, Ref } from "effect";

import type { ContractSyncSummary } from "../sync/index.ts";

/** How often the runtime logs aggregate progress while a run is in flight. */
export const PROGRESS_LOG_INTERVAL = Duration.seconds(5);

/** Latest per-contract snapshots, updated from `SyncEvent`s as they arrive. */
export interface ProgressTrackerState {
  readonly contracts: readonly ContractSyncSummary[];
  readonly safeBlockHeight?: number;
}

export interface RunProgress {
  readonly completedBlocks: number;
  readonly totalBlocks: number | undefined;
  readonly percent: number | undefined;
  readonly activeContracts: number;
  readonly doneContracts: number;
  readonly pagesFetched: number;
  readonly transactionsFetched: number;
  readonly eventsStored: number;
  readonly fromBlock: number | undefined;
  readonly toBlock: number | undefined;
}

/**
 * Aggregates per-contract sync summaries into run progress.
 *
 * A contract contributes to the percentage only when both bounds are known: a
 * lower bound (`startBlock`, or the height at which the run started syncing)
 * and a target (`endBlock`, or the chain tip read once per run). Contracts that
 * are already up to date count as fully completed. The percentage is omitted
 * rather than faked when any contract is unbounded.
 */
export function computeRunProgress(options: {
  contracts: readonly ContractSyncSummary[];
  tipBlockHeight?: number;
}): RunProgress {
  let completedBlocks = 0;
  let totalBlocks = 0;
  let boundedContracts = 0;
  let activeContracts = 0;
  let doneContracts = 0;
  let pagesFetched = 0;
  let transactionsFetched = 0;
  let eventsStored = 0;
  let fromBlock: number | undefined = undefined;
  let toBlock: number | undefined = undefined;

  for (const contract of options.contracts) {
    pagesFetched += contract.pagesFetched;
    transactionsFetched += contract.transactionsFetched;
    eventsStored += contract.eventsStored;

    if (contract.doneAtStart) {
      doneContracts += 1;
    } else {
      activeContracts += 1;
    }

    const lower = contract.startBlock ?? contract.initialBlockHeight;
    const target = contract.endBlock ?? options.tipBlockHeight;

    if (lower !== undefined) {
      fromBlock = fromBlock === undefined ? lower : Math.min(fromBlock, lower);
    }

    if (target !== undefined) {
      toBlock = toBlock === undefined ? target : Math.max(toBlock, target);
    }

    if (lower !== undefined && target !== undefined) {
      boundedContracts += 1;

      const range = Math.max(target - lower + 1, 0);
      totalBlocks += range;

      if (contract.doneAtStart) {
        completedBlocks += range;
      } else {
        const syncedTo = contract.lastBlockHeight ?? lower - 1;
        completedBlocks += Math.min(Math.max(syncedTo - lower + 1, 0), range);
      }
    }
  }

  const boundsAreKnown = boundedContracts > 0 && boundedContracts === options.contracts.length;

  const percent =
    boundsAreKnown && totalBlocks > 0
      ? Math.min(Math.round((completedBlocks / totalBlocks) * 1000) / 10, 100)
      : undefined;

  return {
    completedBlocks,
    totalBlocks: boundedContracts > 0 ? totalBlocks : undefined,
    percent,
    activeContracts,
    doneContracts,
    pagesFetched,
    transactionsFetched,
    eventsStored,
    fromBlock,
    toBlock,
  };
}

export interface EtaEstimator {
  /**
   * Records the cumulative completed blocks and returns an ETA in milliseconds
   * once enough samples have been collected.
   *
   * Uses an exponentially weighted average of the millis-per-block rate over
   * up to 10 samples, emitted only after three.
   */
  readonly sample: (input: {
    completedBlocks: number;
    remainingBlocks: number | undefined;
    nowMillis: number;
  }) => number | undefined;
}

const ETA_WINDOW = 10;

const ETA_MIN_SAMPLES = 3;

const ETA_SAMPLE_INTERVAL_MILLIS = 5_000;

export function createEtaEstimator(): EtaEstimator {
  const batches: { elapsedMillis: number; completedBlocks: number }[] = [
    { elapsedMillis: 0, completedBlocks: 0 },
  ];

  let isInitialized = false;
  let previousTimestamp = 0;
  let previousCompletedBlocks = 0;
  let millisPerBlock = 0;

  return {
    sample: ({ completedBlocks, remainingBlocks, nowMillis }) => {
      if (remainingBlocks === undefined) {
        return undefined;
      }

      if (!isInitialized) {
        isInitialized = true;
        previousTimestamp = nowMillis;
        previousCompletedBlocks = completedBlocks;

        return undefined;
      }

      const lastBatch = batches[batches.length - 1];

      if (lastBatch === undefined) {
        return undefined;
      }

      lastBatch.elapsedMillis = Math.max(nowMillis - previousTimestamp, 0);
      lastBatch.completedBlocks = Math.max(completedBlocks - previousCompletedBlocks, 0);

      if (
        nowMillis - previousTimestamp > ETA_SAMPLE_INTERVAL_MILLIS &&
        lastBatch.completedBlocks > 0
      ) {
        batches.push({ elapsedMillis: 0, completedBlocks: 0 });

        if (batches.length > ETA_WINDOW) {
          batches.shift();
        }

        previousTimestamp = nowMillis;
        previousCompletedBlocks = completedBlocks;

        if (batches.length >= ETA_MIN_SAMPLES) {
          let weighted = 0;
          let weight = 0;

          for (let index = 0; index < batches.length - 1; index += 1) {
            const batch = batches[index];

            if (batch !== undefined && batch.completedBlocks > 0) {
              const multiplier = 1 / 1.5 ** (ETA_WINDOW - 1 - index);
              weighted += (multiplier * batch.elapsedMillis) / batch.completedBlocks;
              weight += multiplier;
            }
          }

          millisPerBlock = weight === 0 ? 0 : weighted / weight;
        }
      }

      if (batches.length < ETA_MIN_SAMPLES || millisPerBlock <= 0) {
        return undefined;
      }

      return Math.round(millisPerBlock * remainingBlocks);
    },
  };
}

interface ProgressLogAnnotations {
  chainId: number;
  phase: string;
  completedBlocks: number;
  pagesFetched: number;
  transactionsFetched: number;
  eventsStored: number;
  activeContracts: number;
  doneContracts: number;
  percent?: number;
  totalBlocks?: number;
  fromBlock?: number;
  toBlock?: number;
  safeBlockHeight?: number;
  etaMillis?: number;
}

/**
 * Reads the latest snapshots and logs one aggregate progress line. Skips until
 * the sync stream has emitted its first snapshot.
 */
export function logRunProgress(options: {
  chainId: number;
  state: Ref.Ref<ProgressTrackerState>;
  tipBlockHeight: number | undefined;
  estimator: EtaEstimator;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const { contracts, safeBlockHeight } = yield* Ref.get(options.state);

    if (contracts.length === 0) {
      return;
    }

    const progress = computeRunProgress({
      contracts,
      tipBlockHeight: options.tipBlockHeight,
    });

    const nowMillis = yield* Clock.currentTimeMillis;

    const etaMillis = options.estimator.sample({
      completedBlocks: progress.completedBlocks,
      remainingBlocks:
        progress.totalBlocks === undefined
          ? undefined
          : Math.max(progress.totalBlocks - progress.completedBlocks, 0),
      nowMillis,
    });

    const annotations: ProgressLogAnnotations = {
      chainId: options.chainId,
      phase: "progress",
      completedBlocks: progress.completedBlocks,
      pagesFetched: progress.pagesFetched,
      transactionsFetched: progress.transactionsFetched,
      eventsStored: progress.eventsStored,
      activeContracts: progress.activeContracts,
      doneContracts: progress.doneContracts,
    };

    if (progress.percent !== undefined) {
      annotations.percent = progress.percent;
    }

    if (progress.totalBlocks !== undefined) {
      annotations.totalBlocks = progress.totalBlocks;
    }

    if (progress.fromBlock !== undefined) {
      annotations.fromBlock = progress.fromBlock;
    }

    if (progress.toBlock !== undefined) {
      annotations.toBlock = progress.toBlock;
    }

    if (safeBlockHeight !== undefined) {
      annotations.safeBlockHeight = safeBlockHeight;
    }

    if (etaMillis !== undefined) {
      annotations.etaMillis = etaMillis;
    }

    yield* Effect.logInfo("Historical sync progress").pipe(Effect.annotateLogs({ ...annotations }));
  });
}
