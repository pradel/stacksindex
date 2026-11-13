import { Effect, Metric, Predicate } from "effect";
import { HttpClientError } from "effect/http";

import type { IndexerDatabase } from "../database/index.ts";
import { StacksClient, type StacksHttpError } from "../datasources/api/index.ts";
import { ReorgError, type SyncStoreError } from "../lib/errors.ts";
import {
  indexingBlock,
  indexingBlockTimestamp,
  indexingFinalizedBlock,
  reorgDepth,
  reorgs,
} from "../lib/metrics.ts";
import { syncStore } from "../sync-store/index.ts";

/** Mirrors a committed checkpoint into the indexing gauges. */
export function recordCheckpointMetrics(checkpoint: {
  readonly blockHeight: number | bigint;
  readonly blockTime: number | bigint;
  readonly finalizedBlockHeight: number | bigint;
}): Effect.Effect<void> {
  return Effect.all(
    [
      Metric.update(indexingBlock, Number(checkpoint.blockHeight)),
      Metric.update(indexingBlockTimestamp, Number(checkpoint.blockTime)),
      Metric.update(indexingFinalizedBlock, Number(checkpoint.finalizedBlockHeight)),
    ],
    { discard: true },
  );
}

/** Rewinds to `blockHeight` and refreshes the indexing gauges when the checkpoint moved. */
function rewind(
  chainId: number,
  blockHeight: number,
): Effect.Effect<
  { fromBlockHeight: number; toBlockHeight: number } | null,
  SyncStoreError,
  IndexerDatabase
> {
  return Effect.gen(function* () {
    const replayed = yield* syncStore.rewindTo({ chainId, blockHeight });

    if (replayed !== null) {
      const checkpoint = yield* syncStore.getCheckpoint({ chainId });

      if (checkpoint !== null) {
        yield* recordCheckpointMetrics(checkpoint);
      }
    }

    return replayed;
  });
}

/** Canonical hash of the block at `height`, or `undefined` when there is none. */
function getCanonicalBlockHash(
  height: number,
): Effect.Effect<string | undefined, StacksHttpError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;

    return (yield* client.getBlock(height)).hash;
  }).pipe(
    Effect.catchIf(
      (error) =>
        HttpClientError.isHttpClientError(error) &&
        Predicate.isTagged(error.reason, "StatusCodeError") &&
        error.reason.response.status === 404,
      () => Effect.succeed(undefined),
    ),
  );
}

/**
 * Makes the stored chain consistent with the canonical chain before syncing.
 *
 * The anchor is the chain tip read at the start of the previous run; nothing
 * above it was indexed. When its block is still canonical, so is every stored
 * block below it, and only the never-indexed data fetched above it is dropped.
 * Otherwise a reorg replaced it: the highest stored block that is still
 * canonical is found by binary search (stored blocks are a canonical prefix
 * followed by orphaned ones) and everything above it is refetched and
 * replayed. A reorg that replaced the finalized block fails the run.
 *
 * Without an anchor (the previous pass could not read the chain tip, so its
 * indexing was not capped) the newest stored block at or below the checkpoint
 * stands in for it: nothing above the checkpoint was indexed. Only when no
 * block is stored there is the unfinalized range rewound unverified; it holds
 * no stored event, so nothing is replayed through handlers.
 *
 * `anchorIsCanonical` skips the canonical-hash request when the caller already
 * proved the anchor canonical, e.g. a new head whose parent is the anchor.
 *
 * Every pass starts here, so the indexing gauges are seeded from the stored
 * checkpoint (populated after a restart) and refreshed after each rewind.
 */
export function reconcileWithCanonicalChain(
  chainId: number,
  options?: { readonly anchorIsCanonical?: boolean },
): Effect.Effect<
  void,
  StacksHttpError | ReorgError | SyncStoreError,
  StacksClient | IndexerDatabase
> {
  return Effect.gen(function* () {
    const storedAnchor = yield* syncStore.getSyncAnchor({ chainId });
    const checkpoint = yield* syncStore.getCheckpoint({ chainId });
    const finalizedBlockHeight = checkpoint === null ? 0 : Number(checkpoint.finalizedBlockHeight);

    if (checkpoint !== null) {
      yield* recordCheckpointMetrics(checkpoint);
    }

    let anchor = storedAnchor;

    if (anchor === null) {
      if (checkpoint === null || Number(checkpoint.blockHeight) <= finalizedBlockHeight) {
        return;
      }

      const checkpointBlock = (yield* syncStore.getStoredBlocks({
        chainId,
        fromBlockHeight: finalizedBlockHeight,
        toBlockHeight: Number(checkpoint.blockHeight),
      })).at(-1);

      if (checkpointBlock === undefined) {
        yield* rewind(chainId, finalizedBlockHeight);

        return;
      }

      yield* Effect.logInfo(
        `No chain tip saved by the previous pass; verifying stored block ${checkpointBlock.height} instead`,
      ).pipe(Effect.annotateLogs({ chainId, phase: "init", block: checkpointBlock.height }));

      anchor = { blockHeight: checkpointBlock.height, blockHash: checkpointBlock.hash };
    }

    if (
      (storedAnchor !== null && options?.anchorIsCanonical === true) ||
      (yield* getCanonicalBlockHash(anchor.blockHeight)) === anchor.blockHash
    ) {
      yield* rewind(chainId, anchor.blockHeight);

      return;
    }

    const blocks = yield* syncStore.getStoredBlocks({
      chainId,
      fromBlockHeight: finalizedBlockHeight,
      toBlockHeight: anchor.blockHeight,
    });

    let ancestorIndex = -1;
    let low = 0;
    let high = blocks.length - 1;

    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const block = blocks[middle];

      if ((yield* getCanonicalBlockHash(block.height)) === block.hash) {
        ancestorIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    const [lowest] = blocks;

    if (
      ancestorIndex === -1 &&
      finalizedBlockHeight > 0 &&
      lowest?.height === finalizedBlockHeight
    ) {
      return yield* new ReorgError({
        finalizedBlockHeight,
        blockHeight: finalizedBlockHeight,
        message: `Chain reorganization replaced finalized block ${finalizedBlockHeight}, so indexed data at or below it may belong to an orphaned fork. Re-sync from an empty indexer database (and reset handler tables), and raise \`finality\` to tolerate deeper reorgs.`,
      });
    }

    const ancestorBlockHeight =
      ancestorIndex === -1 ? finalizedBlockHeight : blocks[ancestorIndex].height;

    const replayed = yield* rewind(chainId, ancestorBlockHeight);

    // Depth counts the heights from the highest still-canonical stored block
    // (exclusive) up to the anchor (inclusive): the stored range the reorg may
    // Have replaced. It is independent of where the checkpoint was, since
    // Stored-but-unindexed blocks are refetched as well.
    yield* Metric.update(reorgs, 1);
    yield* Metric.update(reorgDepth, anchor.blockHeight - ancestorBlockHeight);

    yield* Effect.logWarning(
      `Chain reorganization detected: block ${anchor.blockHeight} is no longer canonical; refetching from block ${ancestorBlockHeight + 1}`,
    ).pipe(
      Effect.annotateLogs({
        chainId,
        phase: "init",
        anchorBlockHeight: anchor.blockHeight,
        ancestorBlockHeight,
        replayedFromBlockHeight: replayed?.fromBlockHeight ?? null,
      }),
    );
  });
}
