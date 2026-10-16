import {
  Clock,
  Duration,
  Effect,
  Metric,
  Predicate,
  Ref,
  References,
  Result,
  Stream,
} from "effect";
import type { Socket } from "effect/socket";

import type { IndexerDatabase } from "../database/index.ts";
import { blockHeads, type LightBlock, toLightBlock } from "../datasources/api/heads.ts";
import { StacksClient, type StacksHttpError } from "../datasources/api/index.ts";
import { Indexing } from "../indexing/index.ts";
import type { SyncStoreError } from "../lib/errors.ts";
import { createFailureBudget } from "../lib/failure-budget.ts";
import {
  chainTipBlock,
  liveBlockArrivalLatency,
  liveConsecutiveFailures,
  liveIsRealtime,
  livePassDuration,
  syncErrors,
} from "../lib/metrics.ts";
import { estimateBlockRequests, syncBlock } from "../sync-realtime/block.ts";
import { syncStore } from "../sync-store/index.ts";
import type { SyncService } from "../sync/index.ts";
import type { IndexerError, ResolvedIndexerConfig } from "./config.ts";
import type { Filter } from "./filters.ts";
import {
  getSyncingContractIds,
  indexEventsUpTo,
  type PreparedFilters,
  prepareFilters,
  runPreparedHistorical,
  syncAndIndexTo,
} from "./historical.ts";
import { reconcileWithCanonicalChain } from "./reorg.ts";
import { RunPhase } from "./status.ts";

/** Max blocks a per-block fetch covers: one `GET /extended/v2/blocks` page. */
const MAX_BLOCKS_PER_FETCH = 30;

const livePassDurationByFetch: Record<FetchPlan["type"], typeof livePassDuration> = {
  blocks: Metric.withAttributes(livePassDuration, { fetch: "blocks" }),
  contracts: Metric.withAttributes(livePassDuration, { fetch: "contracts" }),
};

const liveSyncErrors = Metric.withAttributes(syncErrors, { mode: "live" });

/**
 * Errors worth retrying with the next head: API transport, status and rate
 * limit failures, and transaction batches missing ids the API has not caught
 * up on yet. Handler, database, cursor and reorg errors fail `live` at once.
 */
function isTransientError(error: IndexerError): boolean {
  return !(
    Predicate.isTagged(error, "HandlerExecutionError") ||
    Predicate.isTagged(error, "ReorgError") ||
    Predicate.isTagged(error, "SyncStoreError") ||
    Predicate.isTagged(error, "DatabaseError") ||
    Predicate.isTagged(error, "MigrationError") ||
    Predicate.isTagged(error, "FilterValidationError") ||
    Predicate.isTagged(error, "InvalidCursorError")
  );
}

/**
 * Height at which every filter is complete, or `undefined` when at least one
 * filter is open-ended and `live` follows the chain indefinitely.
 */
function getEndBlockHeight(prepared: PreparedFilters): number | undefined {
  let endHeight = 0;

  for (const filter of prepared.filterMap.values()) {
    if (filter.endBlock === undefined) {
      return undefined;
    }

    endHeight = Math.max(endHeight, filter.endBlock);
  }

  return endHeight;
}

type HeadOutcome =
  | { readonly type: "skipped" }
  | { readonly type: "indexed"; readonly blockHeight: number };

/**
 * How a head is fetched:
 *
 * - `blocks`: the events of every block between the anchor and the head, one
 *   block at a time. Costs grow with chain activity.
 * - `contracts`: each contract's newest logs page (the historical catch-up).
 *   Costs grow with the number of contracts.
 *
 * `anchorIsCanonical` records that the fetched blocks link the head back to
 * the anchor, so the reorg check needs no request.
 */
type FetchPlan =
  | { readonly type: "blocks"; readonly blocks: readonly LightBlock[]; readonly requests: number }
  | { readonly type: "contracts"; readonly anchorIsCanonical: boolean };

/**
 * The blocks above the anchor up to `head`, ascending, when they form a
 * chain from the anchor to the head; `undefined` otherwise (a reorg, or a gap
 * wider than one blocks page).
 */
function getLinkedBlocks(
  anchor: { readonly blockHeight: number; readonly blockHash: string },
  head: LightBlock,
): Effect.Effect<LightBlock[] | undefined, StacksHttpError, StacksClient> {
  return Effect.gen(function* () {
    if (head.height === anchor.blockHeight + 1) {
      return head.parentHash === anchor.blockHash ? [head] : undefined;
    }

    const client = yield* StacksClient;
    const page = yield* client.getBlocks({ limit: MAX_BLOCKS_PER_FETCH });

    const blocks = page.results
      .map(toLightBlock)
      .filter((block) => block.height > anchor.blockHeight && block.height <= head.height)
      .toSorted((a, b) => a.height - b.height);

    let parentHash = anchor.blockHash;

    for (const block of blocks) {
      if (block.parentHash !== parentHash) {
        return undefined;
      }

      parentHash = block.hash;
    }

    const isComplete =
      blocks.length === head.height - anchor.blockHeight && parentHash === head.hash;

    return isComplete ? blocks : undefined;
  });
}

/**
 * Picks the cheaper way to fetch `head`. The per-block path needs blocks that
 * link the head to the anchor and every syncing contract synced through the
 * anchor (the previous pass completed); it is taken only when it costs fewer
 * requests than one logs page per syncing contract.
 */
function planFetch(options: {
  readonly chainId: number;
  readonly prepared: PreparedFilters;
  readonly anchor: { readonly blockHeight: number; readonly blockHash: string } | null;
  readonly head: LightBlock;
}): Effect.Effect<FetchPlan, StacksHttpError | SyncStoreError, StacksClient | IndexerDatabase> {
  const { chainId, anchor, head } = options;

  return Effect.gen(function* () {
    if (anchor === null || head.height <= anchor.blockHeight) {
      return { type: "contracts", anchorIsCanonical: false } as const;
    }

    const gap = head.height - anchor.blockHeight;
    const contractIds = getSyncingContractIds(options.prepared, anchor.blockHeight + 1);

    // Every block costs at least one request, plus one to list them.
    const minimumBlockRequests = gap === 1 ? 1 : gap + 1;

    if (gap > MAX_BLOCKS_PER_FETCH || minimumBlockRequests >= contractIds.length) {
      return {
        type: "contracts",
        anchorIsCanonical: gap === 1 && head.parentHash === anchor.blockHash,
      } as const;
    }

    const blocks = yield* getLinkedBlocks(anchor, head);

    if (blocks === undefined) {
      return { type: "contracts", anchorIsCanonical: false } as const;
    }

    for (const contractId of contractIds) {
      const progress = yield* syncStore.getSyncProgress({ chainId, contractId });

      if (progress?.cursor !== null || Number(progress.syncedBlockHeight) < anchor.blockHeight) {
        return { type: "contracts", anchorIsCanonical: true } as const;
      }
    }

    let requests = 0;

    for (const block of blocks) {
      requests += estimateBlockRequests(block);
    }

    return requests < contractIds.length
      ? ({ type: "blocks", blocks, requests } as const)
      : ({ type: "contracts", anchorIsCanonical: true } as const);
  });
}

/**
 * Fetches `head` block by block, then indexes up to it. The blocks link the
 * head to the anchor, so the anchor is canonical; the check only drops data
 * stored above it by an earlier pass.
 */
function syncBlocksAndIndexTo(options: {
  readonly config: ResolvedIndexerConfig;
  readonly prepared: PreparedFilters;
  readonly head: LightBlock;
  readonly blocks: readonly LightBlock[];
  readonly eventsByContract: Map<string, number>;
}): Effect.Effect<void, IndexerError, StacksClient | IndexerDatabase | Indexing> {
  const { config, prepared, head } = options;
  const { chainId } = config;

  return Effect.gen(function* () {
    yield* reconcileWithCanonicalChain(chainId, { anchorIsCanonical: true });
    yield* syncStore.setSyncAnchor({
      chainId,
      anchor: { blockHeight: head.height, blockHash: head.hash },
    });

    for (const block of options.blocks) {
      yield* syncBlock({ chainId, block, filters: prepared.syncFilters });
    }

    yield* indexEventsUpTo(
      head.height,
      prepared.filterMap,
      chainId,
      options.eventsByContract,
      config.finality,
      head.height,
    );
  });
}

/**
 * Syncs and indexes up to `head`. A head that is already the anchor, or that
 * is older than it (a lagging API replica), is skipped: lowering the anchor
 * would replay indexed blocks.
 */
function processHead(options: {
  readonly config: ResolvedIndexerConfig;
  readonly sync: SyncService;
  readonly prepared: PreparedFilters;
  readonly head: LightBlock;
}): Effect.Effect<HeadOutcome, IndexerError, StacksClient | IndexerDatabase | Indexing> {
  const { config, prepared, head } = options;
  const { chainId } = config;

  return Effect.gen(function* () {
    const anchor = yield* syncStore.getSyncAnchor({ chainId });

    if (anchor !== null && (anchor.blockHash === head.hash || head.height < anchor.blockHeight)) {
      return { type: "skipped" } as const;
    }

    // `blockTime` is the block's Unix timestamp in seconds. Clocks may disagree
    // By a little, so a block stamped after now counts as no latency.
    const now = yield* Clock.currentTimeMillis;

    yield* Metric.update(liveBlockArrivalLatency, Math.max(0, now - head.blockTime * 1000));

    const plan = yield* planFetch({ chainId, prepared, anchor, head });
    const eventsByContract = new Map<string, number>();

    // A one-shot run reports per-contract sync progress at info. A live pass
    // Reports one line per head instead, so its per-contract chatter is only
    // Shown when the minimum level is already more verbose than info.
    const minimumLogLevel = yield* References.MinimumLogLevel;

    const pass =
      plan.type === "blocks"
        ? syncBlocksAndIndexTo({ config, prepared, head, blocks: plan.blocks, eventsByContract })
        : syncAndIndexTo({
            chainId,
            finality: config.finality,
            sync: options.sync,
            prepared,
            tip: { blockHeight: head.height, blockHash: head.hash },
            eventsByContract,
            logProgress: false,
            anchorIsCanonical: plan.anchorIsCanonical,
          });

    const [duration] = yield* Effect.timed(
      pass.pipe(
        Effect.provideService(
          References.MinimumLogLevel,
          minimumLogLevel === "Info" ? "Warn" : minimumLogLevel,
        ),
      ),
    );

    // Both passes moved the sync anchor to the head.
    yield* Metric.update(livePassDurationByFetch[plan.type], Duration.toMillis(duration));
    yield* Metric.update(chainTipBlock, head.height);

    let events = 0;

    for (const count of eventsByContract.values()) {
      events += count;
    }

    const annotations = {
      chainId,
      phase: "live",
      block: head.height,
      fetch: plan.type,
      events,
      durationMs: Duration.toMillis(duration),
    };

    yield* events > 0
      ? Effect.logInfo(`Indexed ${events} events up to block ${head.height}`).pipe(
          Effect.annotateLogs(annotations),
        )
      : Effect.logDebug(`Synced to block ${head.height}`).pipe(Effect.annotateLogs(annotations));

    return { type: "indexed", blockHeight: head.height } as const;
  });
}

/**
 * Runs a historical pass, then follows new chain heads until every filter
 * reaches its `endBlock`. Heads arriving while one is processed collapse to the
 * newest: each pass catches up over the whole range since the previous one.
 */
export function runLive(
  filters: Filter[],
  config: ResolvedIndexerConfig,
  sync: SyncService,
): Effect.Effect<
  void,
  IndexerError,
  StacksClient | IndexerDatabase | Socket.WebSocketConstructor | RunPhase
> {
  const { chainId } = config;

  return Effect.gen(function* () {
    if (filters.length === 0) {
      return;
    }

    const prepared = yield* prepareFilters(filters);

    yield* runPreparedHistorical(prepared, config, sync);

    const endBlockHeight = getEndBlockHeight(prepared);

    const isComplete = (blockHeight: number) =>
      endBlockHeight !== undefined && blockHeight >= endBlockHeight;

    const anchor = yield* syncStore.getSyncAnchor({ chainId });

    if (anchor !== null && isComplete(anchor.blockHeight)) {
      yield* Effect.logInfo("Every filter reached its end block; live indexing complete").pipe(
        Effect.annotateLogs({ chainId, phase: "live", block: anchor.blockHeight }),
      );

      return;
    }

    yield* Effect.logInfo("Following new blocks").pipe(
      Effect.annotateLogs({
        chainId,
        phase: "live",
        transport: config.live.transport,
        pollingInterval: config.live.pollingInterval,
        block: anchor?.blockHeight ?? null,
      }),
    );

    yield* Ref.set(yield* RunPhase, "live");
    yield* Metric.update(liveIsRealtime, 1);

    const budget = createFailureBudget();

    const handleHead = (head: LightBlock) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.result(processHead({ config, sync, prepared, head }));

        if (Result.isSuccess(outcome)) {
          budget.reset();
          yield* Metric.update(liveConsecutiveFailures, 0);

          return outcome.success.type === "skipped" || !isComplete(outcome.success.blockHeight);
        }

        const error = outcome.failure;
        const isSpent = budget.recordFailure(yield* Clock.currentTimeMillis);

        yield* Metric.update(liveSyncErrors, 1);
        yield* Metric.update(liveConsecutiveFailures, budget.consecutiveFailures());

        if (!isTransientError(error) || isSpent) {
          return yield* Effect.fail(error);
        }

        yield* Effect.logWarning(
          `Failed to index block ${head.height}; retrying with the next block`,
        ).pipe(
          Effect.annotateLogs({
            chainId,
            phase: "live",
            block: head.height,
            consecutiveFailures: budget.consecutiveFailures(),
            error: String(error),
          }),
        );

        return true;
      });

    yield* blockHeads({ chainId, ...config.live }).pipe(
      Stream.buffer({ capacity: 1, strategy: "sliding" }),
      Stream.runForEachWhile(handleHead),
      Effect.provide(Indexing.layer({ handlers: prepared.handlers })),
    );

    yield* Effect.logInfo("Every filter reached its end block; live indexing complete").pipe(
      Effect.annotateLogs({ chainId, phase: "live" }),
    );
  }).pipe(
    Effect.ensuring(Metric.update(liveIsRealtime, 0)),
    Effect.annotateLogs({ service: "indexer" }),
    Effect.withLogSpan("liveIndexing"),
  );
}
