import { Effect, Metric, Predicate } from "effect";
import { HttpClientError } from "effect/http";

import { IndexerDatabase } from "../database/index.ts";
import {
  type StacksHttpError,
  StacksClient,
  type StorableBlock,
} from "../datasources/api/index.ts";
import type { DatabaseError, SyncStoreError } from "../lib/errors.ts";
import { blockSourceAttributes, syncBlock, syncComplete } from "../lib/metrics.ts";
import { nextBlockSourceHeight } from "../runtime/blocks.ts";
import { syncStore } from "../sync-store/index.ts";

/** Max rows of one `GET /extended/v2/blocks` page. */
export const BLOCKS_PAGE_LIMIT = 30;

/**
 * Block source resolved by the runtime: `endBlock` is a concrete height and
 * the handler is stripped. `name` is the definition name, which keys its
 * progress.
 */
export interface BlockSyncFilter {
  readonly name: string;
  readonly interval: number;
  readonly startBlock: number;
  readonly endBlock?: number;
}

/** Per-block-source snapshot surfaced to the runtime, like `ContractSyncSummary`. */
export interface BlockSyncSummary {
  readonly name: string;
  readonly doneAtStart: boolean;
  readonly startBlock: number;
  readonly endBlock?: number;
  /** Every block the source runs at, at or below this height, is stored. */
  readonly lastBlockHeight: number;
  /** Height at which this run began syncing. */
  readonly initialBlockHeight: number;
  /** Stacks API requests made for the source by this run. */
  readonly requests: number;
  /** Blocks fetched and stored for the source by this run. */
  readonly blocksFetched: number;
}

/**
 * A block source syncs in windows of up to `BLOCKS_PAGE_LIMIT` consecutive
 * heights, from `syncedBlockHeight` up to `targetBlockHeight`: its `endBlock`,
 * capped by the chain tip read for the pass.
 */
export interface BlockSyncState {
  readonly filter: BlockSyncFilter;
  readonly targetBlockHeight: number;
  syncedBlockHeight: number;
  readonly initialBlockHeight: number;
  /**
   * Bitcoin block times by height, read with the latest window's Stacks
   * blocks; a Nakamoto tenure spans many windows, so its time is reused.
   */
  bitcoinBlockTimes: Map<number, number>;
  requests: number;
  blocksFetched: number;
  done: boolean;
  doneAtStart: boolean;
  readonly metrics: {
    readonly block: Metric.Metric<number, Metric.GaugeState<number>>;
    readonly complete: Metric.Metric<number, Metric.GaugeState<number>>;
  };
}

export function toBlockSyncSummary(state: BlockSyncState): BlockSyncSummary {
  return {
    name: state.filter.name,
    doneAtStart: state.doneAtStart,
    startBlock: state.filter.startBlock,
    endBlock: state.filter.endBlock,
    lastBlockHeight: state.syncedBlockHeight,
    initialBlockHeight: state.initialBlockHeight,
    requests: state.requests,
    blocksFetched: state.blocksFetched,
  };
}

const isComplete = (filter: BlockSyncFilter, syncedBlockHeight: number): boolean =>
  filter.endBlock !== undefined && syncedBlockHeight >= filter.endBlock;

/**
 * Loads the source's progress, starting over from `startBlock` when there is
 * none or it was made for another `interval` or `startBlock`. Without a tip
 * the source cannot be bounded, so it stays at its synced height this pass.
 */
export function initBlockSyncState(
  filter: BlockSyncFilter,
  chainId: number,
  tipBlockHeight: number | undefined,
): Effect.Effect<BlockSyncState, SyncStoreError, IndexerDatabase> {
  return Effect.gen(function* () {
    const saved = yield* syncStore.getBlockSyncProgress({ chainId, name: filter.name });

    const isSameDefinition =
      saved !== null &&
      Number(saved.interval) === filter.interval &&
      Number(saved.startBlock) === filter.startBlock;

    const syncedBlockHeight = isSameDefinition
      ? Number(saved.syncedBlockHeight)
      : Math.max(filter.startBlock - 1, 0);

    if (!isSameDefinition) {
      if (saved !== null) {
        yield* Effect.logInfo(
          `Block source ${filter.name} changed its interval or startBlock; syncing from block ${filter.startBlock}`,
        ).pipe(Effect.annotateLogs({ chainId, blocks: filter.name, phase: "init" }));
      }

      yield* syncStore.upsertBlockSyncProgress({
        chainId,
        name: filter.name,
        interval: filter.interval,
        startBlock: filter.startBlock,
        syncedBlockHeight,
        isComplete: false,
      });
    }

    const targetBlockHeight =
      tipBlockHeight === undefined
        ? syncedBlockHeight
        : Math.min(filter.endBlock ?? tipBlockHeight, tipBlockHeight);

    const done = syncedBlockHeight >= targetBlockHeight;
    const attributes = blockSourceAttributes(filter.name);

    const state: BlockSyncState = {
      filter,
      targetBlockHeight,
      syncedBlockHeight,
      initialBlockHeight: syncedBlockHeight,
      bitcoinBlockTimes: new Map(),
      requests: 0,
      blocksFetched: 0,
      done,
      doneAtStart: done,
      metrics: {
        block: Metric.withAttributes(syncBlock, attributes),
        complete: Metric.withAttributes(syncComplete, attributes),
      },
    };

    yield* Metric.update(state.metrics.block, syncedBlockHeight);
    yield* Metric.update(state.metrics.complete, isComplete(filter, syncedBlockHeight) ? 1 : 0);

    return state;
  });
}

const isNotFound = (error: StacksHttpError): boolean =>
  HttpClientError.isHttpClientError(error) &&
  Predicate.isTagged(error.reason, "StatusCodeError") &&
  error.reason.response.status === 404;

/** The canonical block at `height`, or `undefined` when there is none (e.g. height 0). */
function fetchBlock(
  state: BlockSyncState,
  height: number,
): Effect.Effect<StorableBlock | undefined, StacksHttpError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    state.requests += 1;

    return yield* client.getBlock(height);
  }).pipe(Effect.catchIf(isNotFound, () => Effect.succeed(undefined)));
}

/**
 * Fewest missing heights in a window read from a blocks page: below it,
 * reading each block costs no more requests than the page plus the Bitcoin
 * block times it lacks.
 */
const MIN_PAGED_HEIGHTS = 3;

/**
 * The times of the Bitcoin blocks at `heights`, from `GET /extended/v3/bitcoin-blocks`
 * pages, reusing the times read for the previous window. Heights the pages
 * do not return are left out.
 */
function fetchBitcoinBlockTimes(
  state: BlockSyncState,
  heights: ReadonlySet<number>,
): Effect.Effect<Map<number, number>, StacksHttpError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    const cached = state.bitcoinBlockTimes;
    const times = new Map<number, number>();
    const missing: number[] = [];

    for (const height of heights) {
      const time = cached.get(height);

      if (time === undefined) {
        missing.push(height);
      } else {
        times.set(height, time);
      }
    }

    // Newest first, as pages are read down from their cursor.
    missing.sort((a, b) => b - a);
    let index = 0;

    while (index < missing.length) {
      const top = missing[index];
      let bottom = top;

      while (index < missing.length && missing[index] > top - BLOCKS_PAGE_LIMIT) {
        bottom = missing[index];
        index += 1;
      }

      state.requests += 1;

      const page = yield* client.getBitcoinBlocks({
        cursor: String(top),
        limit: top - bottom + 1,
      });

      for (const block of page.results) {
        if (heights.has(block.height) && block.time !== null) {
          times.set(block.height, block.time);
        }
      }
    }

    state.bitcoinBlockTimes = times;

    return times;
  });
}

/**
 * Fetches the blocks at `heights`, ascending and spanning at most one page.
 * Few heights are read one by one. More are read from one Stacks blocks page
 * whose cursor is the highest height, with the times of their Bitcoin blocks,
 * which the page lacks; heights the pages miss are then read one by one.
 */
function fetchBlocks(
  state: BlockSyncState,
  heights: readonly number[],
): Effect.Effect<StorableBlock[], StacksHttpError, StacksClient> {
  return Effect.gen(function* () {
    const blocks: StorableBlock[] = [];
    const missing = new Set(heights);

    if (heights.length >= MIN_PAGED_HEIGHTS) {
      const client = yield* StacksClient;
      const top = heights[heights.length - 1];
      state.requests += 1;

      const page = yield* client.getStacksBlocks({
        cursor: String(top),
        limit: top - heights[0] + 1,
      });

      const rows = page.results.filter((row) => missing.has(row.height));

      const times = yield* fetchBitcoinBlockTimes(
        state,
        new Set(rows.map((row) => row.bitcoin_block.height)),
      );

      for (const row of rows) {
        const time = times.get(row.bitcoin_block.height);

        if (time !== undefined) {
          missing.delete(row.height);
          blocks.push({
            height: row.height,
            hash: row.hash,
            index_block_hash: row.index_hash,
            burn_block_time: time,
            burn_block_height: row.bitcoin_block.height,
          });
        }
      }
    }

    for (const height of missing) {
      const block = yield* fetchBlock(state, height);

      if (block !== undefined) {
        blocks.push(block);
      }
    }

    return blocks;
  });
}

/**
 * Syncs the next window: the source's heights within `BLOCKS_PAGE_LIMIT`
 * blocks of its next one, skipping blocks already stored (e.g. by a
 * contract's events). The window's blocks and the raised progress are stored
 * in one transaction.
 */
export function syncBlockWindow(
  state: BlockSyncState,
  chainId: number,
): Effect.Effect<
  void,
  StacksHttpError | SyncStoreError | DatabaseError,
  StacksClient | IndexerDatabase
> {
  return Effect.gen(function* () {
    const { filter, targetBlockHeight } = state;
    const first = nextBlockSourceHeight(filter, state.syncedBlockHeight);
    const heights: number[] = [];
    let syncedBlockHeight = targetBlockHeight;

    if (first !== undefined && first <= targetBlockHeight) {
      const windowEnd = Math.min(first + BLOCKS_PAGE_LIMIT - 1, targetBlockHeight);

      for (let height = first; height <= windowEnd; height += filter.interval) {
        heights.push(height);
      }

      // No height runs between the window's last one and the next.
      syncedBlockHeight = Math.min(
        heights[heights.length - 1] + filter.interval - 1,
        targetBlockHeight,
      );
    }

    const stored =
      heights.length === 0
        ? new Set<number>()
        : new Set(
            yield* syncStore.getStoredBlockHeights({
              chainId,
              fromBlockHeight: heights[0],
              toBlockHeight: heights[heights.length - 1],
            }),
          );

    const blocks = yield* fetchBlocks(
      state,
      heights.filter((height) => !stored.has(height)),
    );

    const complete = isComplete(filter, syncedBlockHeight);

    yield* IndexerDatabase.transaction(() =>
      Effect.gen(function* () {
        yield* syncStore.insertBlocks({ chainId, blocks });
        yield* syncStore.upsertBlockSyncProgress({
          chainId,
          name: filter.name,
          interval: filter.interval,
          startBlock: filter.startBlock,
          syncedBlockHeight,
          isComplete: complete,
        });
      }),
    );

    state.syncedBlockHeight = syncedBlockHeight;
    state.blocksFetched += blocks.length;
    state.done = syncedBlockHeight >= targetBlockHeight;

    yield* Metric.update(state.metrics.block, syncedBlockHeight);
    yield* Metric.update(state.metrics.complete, complete ? 1 : 0);

    yield* Effect.logDebug(`Synced block source ${filter.name} to block ${syncedBlockHeight}`).pipe(
      Effect.annotateLogs({
        chainId,
        blocks: filter.name,
        phase: "sync",
        block: syncedBlockHeight,
        fetched: blocks.length,
      }),
    );
  });
}
