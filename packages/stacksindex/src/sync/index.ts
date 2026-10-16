import { Cause, Context, Duration, Effect, Layer, Metric, Queue, Stream } from "effect";

import { type IndexerDb, IndexerDatabase } from "../database/index.ts";
import {
  type ContractLogsResponse,
  type StacksApiError,
  StacksClient,
  type StacksClientService,
  type StorableBlock,
  type StorableTransaction,
} from "../datasources/api/index.ts";
import { chunkArray } from "../lib/array.ts";
import {
  type DatabaseError,
  type InvalidCursorError,
  type SyncStoreError,
  TransactionBatchError,
} from "../lib/errors.ts";
import { SLOW_OPERATION_MILLIS } from "../lib/logging.ts";
import { syncErrors, syncEvents, syncPages } from "../lib/metrics.ts";
import { syncStore } from "../sync-store/index.ts";
import { getContractEventsFirstCursor, parseLogsCursor } from "./cursor.ts";

/**
 * Max transaction ids per `GET /extended/v3/transactions/batch` call.
 * The API returns summaries for up to 20 mined transactions per request.
 */
const TRANSACTIONS_BATCH_LIMIT = 20;

/**
 * Max contracts initialized (DB read plus catch-up check or cursor discovery)
 * concurrently. Bounded to keep the rate limiter and database from being
 * flooded.
 */
const INITIALIZE_CONCURRENCY = 8;

/**
 * Max contract-log pages buffered while catching up from the newest events.
 * A larger backlog falls back to cursor discovery and forward pagination so
 * memory stays bounded.
 */
const MAX_CATCH_UP_PAGES = 10;

/**
 * Filter resolved by the runtime: `endBlock` is resolved to a concrete height
 * and the handler is stripped because the syncer only needs to know what to
 * fetch.
 */
export interface SyncFilter {
  readonly contractId: string;
  readonly startBlock?: number;
  readonly endBlock?: number;
}

export type SyncError =
  | StacksApiError
  | InvalidCursorError
  | SyncStoreError
  | TransactionBatchError
  | DatabaseError;

/**
 * Per-contract snapshot surfaced to the runtime to build `RunResult`.
 * `doneAtStart` distinguishes "was already fully synced" (`status:
 * "up-to-date"`) from "was synced during this run" (`status: "completed"`).
 */
export interface ContractSyncSummary {
  readonly contractId: string;
  readonly doneAtStart: boolean;
  readonly startBlock?: number;
  readonly endBlock?: number;
  readonly lastBlockHeight?: number;
  /** Height at which this run began syncing (cursor discovery or saved progress). */
  readonly initialBlockHeight?: number;
  readonly pagesFetched: number;
  readonly transactionsFetched: number;
  /** Smart contract log events stored by this run. */
  readonly eventsStored: number;
  /**
   * The contract finished by reading its newest logs page, so every event
   * that existed when that page was fetched is stored. `false` when it
   * finished at its `endBlock` or because first-event discovery found nothing.
   */
  readonly syncedToHead: boolean;
}

/**
 * Values emitted by `SyncService.historical`.
 *
 * - `started`: initial per-contract snapshot, emitted before any fetch.
 * - `safe`: a block height whose events are all durably stored for every
 *   active contract.
 * - `completed`: final per-contract snapshot, emitted once every contract is
 *   synced.
 */
export type SyncEvent =
  | { readonly type: "started"; readonly contracts: readonly ContractSyncSummary[] }
  | {
      readonly type: "safe";
      readonly safeBlockHeight: number;
      readonly contracts: readonly ContractSyncSummary[];
    }
  | { readonly type: "completed"; readonly contracts: readonly ContractSyncSummary[] };

export interface SyncService {
  /**
   * Streams safe-to-index block heights for `filters` in ascending order.
   * The stream fails on any sync error and ends once every contract is synced.
   */
  readonly historical: (filters: readonly SyncFilter[]) => Stream.Stream<SyncEvent, SyncError>;
}

type InitError = StacksApiError | InvalidCursorError | SyncStoreError;

type InitRequirements = StacksClient | IndexerDatabase;

/**
 * A contract is in one of three sync modes:
 *
 * - backfill: `cursor` is set and pages are fetched forward from it.
 * - catch-up: `pendingPages` holds the newest pages, fetched backwards from the
 *   chain head down to `syncedBlockHeight`, and stored oldest first.
 * - needs catch-up: neither is set; the next step fetches the newest pages.
 *
 * The logs endpoint only returns a `next_cursor` when a full page of newer
 * events exists, so forward pagination alone never reaches the newest events.
 * Every contract therefore finishes in catch-up mode.
 */
interface ContractSyncState {
  readonly contractId: string;
  readonly startBlock?: number;
  readonly endBlock?: number;
  cursor: string | null;
  pendingPages: ContractLogsResponse[];
  /** Every event of the contract at or below this height is stored. */
  syncedBlockHeight: number;
  initialBlockHeight: number;
  pagesFetched: number;
  transactionsFetched: number;
  eventsStored: number;
  done: boolean;
  doneAtStart: boolean;
  /** Finished by reading the newest logs page (see `ContractSyncSummary`). */
  syncedToHead: boolean;
}

function makeContractSyncState(filter: SyncFilter, syncedBlockHeight: number): ContractSyncState {
  return {
    contractId: filter.contractId,
    startBlock: filter.startBlock,
    endBlock: filter.endBlock,
    cursor: null,
    pendingPages: [],
    syncedBlockHeight,
    initialBlockHeight: syncedBlockHeight,
    pagesFetched: 0,
    transactionsFetched: 0,
    eventsStored: 0,
    done: false,
    doneAtStart: false,
    syncedToHead: false,
  };
}

function getSafeBlockHeight(states: ContractSyncState[]): number | undefined {
  let minHeight: number | undefined = undefined;

  for (const state of states) {
    if (!state.done && (minHeight === undefined || state.syncedBlockHeight < minHeight)) {
      minHeight = state.syncedBlockHeight;
    }
  }

  return minHeight;
}

function toContractSyncSummary(state: ContractSyncState): ContractSyncSummary {
  return {
    contractId: state.contractId,
    doneAtStart: state.doneAtStart,
    startBlock: state.startBlock,
    endBlock: state.endBlock,
    lastBlockHeight: state.syncedBlockHeight,
    initialBlockHeight: state.initialBlockHeight,
    pagesFetched: state.pagesFetched,
    transactionsFetched: state.transactionsFetched,
    eventsStored: state.eventsStored,
    syncedToHead: state.syncedToHead,
  };
}

function persistProgress(
  state: ContractSyncState,
  chainId: number,
  isComplete = false,
): Effect.Effect<void, SyncStoreError, IndexerDatabase> {
  return syncStore.upsertSyncProgress({
    contractId: state.contractId,
    chainId,
    cursor: state.cursor,
    syncedBlockHeight: state.syncedBlockHeight,
    isComplete,
  });
}

/** Marks the contract synced through its `endBlock`. */
function completeAtEndBlock(
  state: ContractSyncState,
  endBlock: number,
  chainId: number,
): Effect.Effect<void, SyncStoreError, IndexerDatabase> {
  state.cursor = null;
  state.pendingPages = [];
  state.syncedBlockHeight = endBlock;
  state.done = true;

  return persistProgress(state, chainId, true);
}

/** Fetches one contract-log page; `cursor: undefined` fetches the newest page. */
function fetchLogsPage(
  state: ContractSyncState,
  cursor: string | undefined,
  chainId: number,
): Effect.Effect<ContractLogsResponse, StacksApiError | InvalidCursorError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;

    const [fetchDuration, page] = yield* Effect.timed(
      client.getContractLogs(state.contractId, { cursor }),
    );

    const fetchDurationMs = Duration.toMillis(fetchDuration);

    yield* Metric.update(syncPages, 1);
    state.pagesFetched += 1;

    const annotations = {
      chainId,
      contractId: state.contractId,
      phase: "fetch",
      block: cursor === undefined ? "head" : (yield* parseLogsCursor(cursor)).blockHeight,
      durationMs: fetchDurationMs,
    };

    yield* Effect.logDebug("Fetched page").pipe(
      Effect.annotateLogs({ ...annotations, events: page.results.length }),
    );

    if (fetchDurationMs > SLOW_OPERATION_MILLIS) {
      yield* Effect.logWarning("Fetching contract logs is taking longer than expected").pipe(
        Effect.annotateLogs(annotations),
      );
    }

    return page;
  });
}

/**
 * Fetches the pages holding events above `syncedBlockHeight`, walking from
 * the newest page backwards via `prev_cursor`. Returns them oldest first, or
 * `null` when the backlog exceeds `MAX_CATCH_UP_PAGES`.
 *
 * Only cursors returned by this walk are followed, and the API filters logs to
 * the canonical chain, so a saved cursor from an orphaned fork is never used.
 */
function fetchNewPages(
  state: ContractSyncState,
  chainId: number,
): Effect.Effect<ContractLogsResponse[] | null, StacksApiError | InvalidCursorError, StacksClient> {
  return Effect.gen(function* () {
    const pages: ContractLogsResponse[] = [];
    let cursor: string | undefined = undefined;

    for (;;) {
      const page: ContractLogsResponse = yield* fetchLogsPage(state, cursor, chainId);

      if (page.results.length === 0) {
        break;
      }

      // `cursor` is the page's newest event. Absent in some responses, in which
      // Case the page is stored and deduplicated.
      if (
        page.cursor &&
        (yield* parseLogsCursor(page.cursor)).blockHeight <= state.syncedBlockHeight
      ) {
        break;
      }

      pages.push(page);

      // `prev_cursor` is the newest event of the next older page: once it is at
      // Or below the synced height, every newer event is on a fetched page.
      const prevCursor = page.prev_cursor;

      if (
        !prevCursor ||
        (yield* parseLogsCursor(prevCursor)).blockHeight <= state.syncedBlockHeight
      ) {
        break;
      }

      if (pages.length >= MAX_CATCH_UP_PAGES) {
        return null;
      }

      cursor = prevCursor;
    }

    return pages.reverse();
  });
}

/**
 * Starts forward pagination from a cursor found by first-event discovery, or
 * marks the contract done when discovery found no event above its synced
 * height (or only events past `endBlock`).
 */
function beginBackfill(
  state: ContractSyncState,
  cursor: string | null,
  chainId: number,
): Effect.Effect<void, InvalidCursorError | SyncStoreError, IndexerDatabase> {
  return Effect.gen(function* () {
    const { endBlock } = state;

    if (cursor === null) {
      yield* Effect.logInfo(`No events found for ${state.contractId}, skipping`).pipe(
        Effect.annotateLogs({ chainId, contractId: state.contractId, phase: "init" }),
      );

      if (endBlock === undefined) {
        state.done = true;
        yield* persistProgress(state, chainId);

        return;
      }

      yield* completeAtEndBlock(state, endBlock, chainId);

      return;
    }

    const cursorHeight = (yield* parseLogsCursor(cursor)).blockHeight;

    if (endBlock !== undefined && cursorHeight > endBlock) {
      yield* Effect.logInfo(
        `First event for ${state.contractId} at block ${cursorHeight} exceeds endBlock ${endBlock}, skipping`,
      ).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: state.contractId,
          phase: "init",
          block: cursorHeight,
        }),
      );
      yield* completeAtEndBlock(state, endBlock, chainId);

      return;
    }

    yield* Effect.logInfo(`Starting sync for ${state.contractId} from block ${cursorHeight}`).pipe(
      Effect.annotateLogs({
        chainId,
        contractId: state.contractId,
        phase: "init",
        block: cursorHeight,
      }),
    );

    state.cursor = cursor;
    // The discovered cursor is the first event at or above its height.
    state.syncedBlockHeight = Math.max(state.syncedBlockHeight, cursorHeight - 1);
  });
}

/**
 * Fetches the events above `syncedBlockHeight` from the chain head. Marks the
 * contract done when there are none, which costs a single request.
 */
function catchUp(
  state: ContractSyncState,
  chainId: number,
): Effect.Effect<void, InitError, InitRequirements> {
  return Effect.gen(function* () {
    const pages = yield* fetchNewPages(state, chainId);

    if (pages === null) {
      yield* Effect.logInfo(
        `More than ${MAX_CATCH_UP_PAGES} pages of new events for ${state.contractId}, resuming forward sync`,
      ).pipe(
        Effect.annotateLogs({
          chainId,
          contractId: state.contractId,
          phase: "init",
          block: state.syncedBlockHeight,
        }),
      );

      const cursor = yield* getContractEventsFirstCursor(state.contractId, {
        startBlock: Math.max(state.startBlock ?? 0, state.syncedBlockHeight + 1),
      });

      yield* beginBackfill(state, cursor, chainId);

      return;
    }

    if (pages.length === 0) {
      state.done = true;
      state.syncedToHead = true;

      return;
    }

    state.pendingPages = pages;
  });
}

function initContractFromScratch(
  filter: SyncFilter,
  chainId: number,
): Effect.Effect<ContractSyncState, InitError, InitRequirements> {
  return Effect.gen(function* () {
    const state = makeContractSyncState(filter, Math.max((filter.startBlock ?? 0) - 1, 0));

    const cursor = yield* getContractEventsFirstCursor(filter.contractId, {
      startBlock: filter.startBlock,
    });

    yield* beginBackfill(state, cursor, chainId);

    state.doneAtStart = state.done;

    if (state.cursor !== null) {
      state.initialBlockHeight = state.syncedBlockHeight + 1;
    }

    return state;
  });
}

function initContractFromSaved(
  filter: SyncFilter,
  saved: NonNullable<Effect.Success<ReturnType<typeof syncStore.getSyncProgress>>>,
  chainId: number,
): Effect.Effect<ContractSyncState, InitError, InitRequirements> {
  return Effect.gen(function* () {
    const state = makeContractSyncState(filter, Number(saved.syncedBlockHeight));

    const annotations = {
      chainId,
      contractId: filter.contractId,
      phase: "init",
      block: state.syncedBlockHeight,
    };

    if (filter.endBlock !== undefined && state.syncedBlockHeight >= filter.endBlock) {
      yield* Effect.logInfo(
        `Sync already completed for ${filter.contractId} (synced up to block ${state.syncedBlockHeight}), skipping`,
      ).pipe(Effect.annotateLogs(annotations));

      state.done = true;
      state.doneAtStart = true;

      return state;
    }

    if (saved.cursor !== null) {
      const cursorHeight = (yield* parseLogsCursor(saved.cursor)).blockHeight;

      yield* Effect.logInfo(
        `Resuming sync for ${filter.contractId} from block ${cursorHeight}`,
      ).pipe(Effect.annotateLogs({ ...annotations, block: cursorHeight }));

      state.cursor = saved.cursor;

      return state;
    }

    yield* catchUp(state, chainId);

    if (state.done) {
      state.doneAtStart = true;

      yield* Effect.logInfo(
        `No new events for ${filter.contractId} (synced up to block ${state.syncedBlockHeight})`,
      ).pipe(Effect.annotateLogs(annotations));
    } else if (state.pendingPages.length > 0) {
      yield* Effect.logInfo(
        `Catching up ${filter.contractId} from block ${state.syncedBlockHeight + 1}`,
      ).pipe(Effect.annotateLogs({ ...annotations, pages: state.pendingPages.length }));
    }

    return state;
  });
}

function initializeContractStates(
  filters: readonly SyncFilter[],
  chainId: number,
): Effect.Effect<ContractSyncState[], InitError, InitRequirements> {
  return Effect.forEach(
    filters,
    (filter) =>
      Effect.gen(function* () {
        const saved = yield* syncStore.getSyncProgress({
          contractId: filter.contractId,
          chainId,
        });

        return saved === null
          ? yield* initContractFromScratch(filter, chainId)
          : yield* initContractFromSaved(filter, saved, chainId);
      }),
    { concurrency: INITIALIZE_CONCURRENCY },
  );
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

/**
 * Stores a page's events with their transactions and blocks, fetching only
 * transactions not stored yet. Returns the highest stored event block height.
 */
function storeEvents(
  state: ContractSyncState,
  events: ContractLogsResponse["results"],
  block: number | undefined,
  chainId: number,
): Effect.Effect<
  number | undefined,
  StacksApiError | TransactionBatchError | SyncStoreError | DatabaseError,
  StacksClient | IndexerDatabase
> {
  return Effect.gen(function* () {
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

    const [transactionsFetchDuration, transactions] = yield* Effect.timed(
      fetchMissingTransactions(missingTxIds, state.endBlock),
    );

    state.transactionsFetched += transactions.length;

    yield* Effect.logDebug(
      `Transactions: ${txIds.length} total, ${missingTxIds.length} missing`,
    ).pipe(
      Effect.annotateLogs({
        chainId,
        contractId: state.contractId,
        phase: "fetch",
        durationMs: Duration.toMillis(transactionsFetchDuration),
      }),
    );

    const blocks = extractBlocksFromTransactions(transactions);

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

    let maxBlockHeight: number | undefined = undefined;

    const eventsWithBlockHeight = smartContractLogs
      .map((event) => {
        const blockHeight = txBlockHeights.get(event.tx_id) ?? 0;

        return { event, blockHeight };
      })
      .filter((item) => item.blockHeight > 0);

    for (const { blockHeight } of eventsWithBlockHeight) {
      if (maxBlockHeight === undefined || blockHeight > maxBlockHeight) {
        maxBlockHeight = blockHeight;
      }
    }

    const [storeDuration] = yield* Effect.timed(
      IndexerDatabase.transaction(() =>
        Effect.all([
          syncStore.insertBlocks({ blocks, chainId }),
          syncStore.insertTransactions({ transactions, chainId }),
          syncStore.insertEvents({ events: eventsWithBlockHeight, chainId }),
        ]),
      ),
    );

    yield* Metric.update(syncEvents, eventsWithBlockHeight.length);
    state.eventsStored += eventsWithBlockHeight.length;
    yield* Effect.logDebug("Stored page").pipe(
      Effect.annotateLogs({
        chainId,
        contractId: state.contractId,
        phase: "store",
        block: block ?? "head",
        events: eventsWithBlockHeight.length,
        transactions: transactions.length,
        durationMs: Duration.toMillis(storeDuration),
      }),
    );

    return maxBlockHeight;
  });
}

/** Fetches and stores the page at the backfill cursor, then advances it. */
function syncBackfillPage(
  state: ContractSyncState,
  cursor: string,
  chainId: number,
): Effect.Effect<void, SyncError, StacksClient | IndexerDatabase> {
  return Effect.gen(function* () {
    const currentHeight = (yield* parseLogsCursor(cursor)).blockHeight;
    const page = yield* fetchLogsPage(state, cursor, chainId);

    yield* storeEvents(state, page.results, currentHeight, chainId);

    const { endBlock } = state;

    if (endBlock !== undefined && currentHeight > endBlock) {
      yield* completeAtEndBlock(state, endBlock, chainId);

      return;
    }

    // The page holds the events at or below the cursor. Newer events of the
    // Cursor block may sit on the next page.
    state.syncedBlockHeight = Math.max(state.syncedBlockHeight, currentHeight - 1);
    // `next_cursor` is null whenever less than a full page of newer events
    // Exists, so this is not the end of the contract: catch up from the head.
    state.cursor = page.next_cursor;

    yield* persistProgress(state, chainId);
  });
}

/** Stores the oldest pending catch-up page. */
function syncCatchUpPage(
  state: ContractSyncState,
  page: ContractLogsResponse,
  chainId: number,
): Effect.Effect<void, SyncError, StacksClient | IndexerDatabase> {
  return Effect.gen(function* () {
    const isNewestPage = state.pendingPages.length === 0;
    const topHeight = page.cursor ? (yield* parseLogsCursor(page.cursor)).blockHeight : undefined;
    const storedHeight = yield* storeEvents(state, page.results, topHeight, chainId);
    const pageTopHeight = topHeight ?? storedHeight ?? state.syncedBlockHeight;

    // The next newer page may hold more events of this page's top block, so
    // Only the newest page completes it.
    state.syncedBlockHeight = Math.max(
      state.syncedBlockHeight,
      isNewestPage ? pageTopHeight : pageTopHeight - 1,
    );

    const { endBlock } = state;

    if (endBlock !== undefined && state.syncedBlockHeight >= endBlock) {
      yield* completeAtEndBlock(state, endBlock, chainId);

      return;
    }

    state.done = isNewestPage;
    state.syncedToHead = isNewestPage;

    yield* persistProgress(state, chainId);
  });
}

/**
 * Picks the next contract to advance. Fair scheduling: always the lowest
 * position so a single busy contract cannot starve others.
 */
function pickNextState(
  states: ContractSyncState[],
): Effect.Effect<ContractSyncState | undefined, InvalidCursorError> {
  return Effect.gen(function* () {
    let next: ContractSyncState | undefined = undefined;
    let nextHeight = Number.MAX_SAFE_INTEGER;

    for (const state of states) {
      if (!state.done) {
        const height =
          state.cursor === null
            ? state.syncedBlockHeight + 1
            : (yield* parseLogsCursor(state.cursor)).blockHeight;

        if (next === undefined || height < nextHeight) {
          nextHeight = height;
          next = state;
        }
      }
    }

    return next;
  });
}

export const createSync = ({
  chainId,
  client,
  database,
}: {
  chainId: number;
  client: StacksClientService;
  database: IndexerDb;
}): SyncService => ({
  historical: (filters) =>
    Stream.callback<SyncEvent, SyncError>(
      (queue) =>
        Effect.gen(function* () {
          const states = yield* initializeContractStates(filters, chainId);

          yield* Queue.offer(queue, {
            type: "started",
            contracts: states.map(toContractSyncSummary),
          });

          for (;;) {
            const state = yield* pickNextState(states);

            if (state === undefined) {
              break;
            }

            const { cursor } = state;
            const [pendingPage] = state.pendingPages;

            if (pendingPage !== undefined) {
              state.pendingPages.shift();
              yield* syncCatchUpPage(state, pendingPage, chainId);
            } else if (cursor === null) {
              // The backfill reached its newest page: fetch the newest events.
              yield* catchUp(state, chainId);
            } else {
              yield* syncBackfillPage(state, cursor, chainId);
            }

            if (state.done) {
              yield* Effect.logInfo(`Sync complete for ${state.contractId}`).pipe(
                Effect.annotateLogs({
                  chainId,
                  contractId: state.contractId,
                  phase: "sync",
                  block: state.syncedBlockHeight,
                }),
              );
            }

            // Incremental indexing: notify indexer fiber of current safe block
            // Height. A catch-up check stores nothing, so it cannot raise it.
            const safeHeight = getSafeBlockHeight(states);

            if (safeHeight !== undefined && (pendingPage !== undefined || cursor !== null)) {
              yield* Queue.offer(queue, {
                type: "safe",
                safeBlockHeight: safeHeight,
                contracts: states.map(toContractSyncSummary),
              });
            }
          }

          yield* Queue.offer(queue, {
            type: "completed",
            contracts: states.map(toContractSyncSummary),
          });
        }).pipe(
          Effect.provideService(IndexerDatabase, database),
          Effect.provideService(StacksClient, StacksClient.of(client)),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Metric.update(syncErrors, 1).pipe(
                  Effect.andThen(Queue.failCause(queue, cause)),
                  Effect.asVoid,
                ),
          ),
          Effect.ensuring(Queue.end(queue).pipe(Effect.asVoid)),
        ),
      // Bound the producer so a slow consumer (handler work, DB contention)
      // Throttles fetching instead of buffering the whole backfill in memory.
      { bufferSize: 1, strategy: "suspend" },
    ),
});

export class Sync extends Context.Service<Sync, SyncService>()("stacksindex/sync/Sync") {
  static readonly layer = ({
    chainId,
  }: {
    chainId: number;
  }): Layer.Layer<Sync, never, StacksClient | IndexerDatabase> =>
    Layer.effect(
      Sync,
      Effect.gen(function* () {
        const client = yield* StacksClient;
        const database = yield* IndexerDatabase;

        return Sync.of(createSync({ chainId, client, database }));
      }),
    );
}
