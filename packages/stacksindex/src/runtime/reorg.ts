import { Effect, Predicate } from "effect";
import { HttpClientError } from "effect/http";

import type { IndexerDatabase } from "../database/index.ts";
import { StacksClient, type StacksHttpError } from "../datasources/api/index.ts";
import { ReorgError, type SyncStoreError } from "../lib/errors.ts";
import { syncStore } from "../sync-store/index.ts";

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
 * Without an anchor (first run, or the tip could not be read) the stored chain
 * cannot be verified, so everything above the finalized block is replayed.
 *
 * `anchorIsCanonical` skips the canonical-hash request when the caller already
 * proved the anchor canonical, e.g. a new head whose parent is the anchor.
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
    const anchor = yield* syncStore.getSyncAnchor({ chainId });
    const checkpoint = yield* syncStore.getCheckpoint({ chainId });
    const finalizedBlockHeight = checkpoint === null ? 0 : Number(checkpoint.finalizedBlockHeight);

    if (anchor === null) {
      // Unverifiable: replay the unfinalized indexed range, if there is one.
      if (checkpoint === null || Number(checkpoint.blockHeight) <= finalizedBlockHeight) {
        return;
      }

      const replayed = yield* syncStore.rewindTo({ chainId, blockHeight: finalizedBlockHeight });

      if (replayed !== null) {
        yield* Effect.logWarning(
          `Discarded unfinalized data from block ${replayed.fromBlockHeight}; refetching from block ${replayed.toBlockHeight + 1}`,
        ).pipe(Effect.annotateLogs({ chainId, phase: "init", ...replayed }));
      }

      return;
    }

    if (
      options?.anchorIsCanonical === true ||
      (yield* getCanonicalBlockHash(anchor.blockHeight)) === anchor.blockHash
    ) {
      yield* syncStore.rewindTo({ chainId, blockHeight: anchor.blockHeight });

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

    const replayed = yield* syncStore.rewindTo({ chainId, blockHeight: ancestorBlockHeight });

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
