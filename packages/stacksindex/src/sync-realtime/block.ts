import { Effect, Metric } from "effect";

import { IndexerDatabase } from "../database/index.ts";
import type { LightBlock } from "../datasources/api/heads.ts";
import {
  type BlockTransactionsApiResponse,
  type SmartContractLogEvent,
  type StacksApiError,
  StacksClient,
  type StorableBlock,
  type StorableTransaction,
  type TransactionEventsResponse,
} from "../datasources/api/index.ts";
import type { DatabaseError, SyncStoreError } from "../lib/errors.ts";
import {
  blockSourceAttributes,
  contractAttributes,
  syncBlock as syncBlockGauge,
  syncEvents,
} from "../lib/metrics.ts";
import { isBlockSourceHeight } from "../runtime/blocks.ts";
import { syncStore } from "../sync-store/index.ts";
import type { BlockSyncFilter, SyncFilter } from "../sync/index.ts";

type BlockTransaction = BlockTransactionsApiResponse["results"][number];

/** Max results per `GET /extended/v3/blocks/{hash}/transactions` page. */
const BLOCK_TRANSACTIONS_PAGE_LIMIT = 50;

/** Max results per `GET /extended/v3/transactions/{tx_id}/events` page. */
const TRANSACTION_EVENTS_PAGE_LIMIT = 100;

/** Transactions whose events are fetched concurrently within one block. */
const EVENTS_FETCH_CONCURRENCY = 4;

/**
 * Transaction types that may carry contract logs. The others run no Clarity
 * code, and the node attaches no prints to them near the chain tip.
 * Exhaustive, so a type added to the API has to be classified here.
 */
const MAY_HOLD_LOGS: Record<BlockTransaction["type"], boolean> = {
  contract_call: true,
  smart_contract: true,
  // Pre-epoch-2.5 coinbases carried pox-2/pox-3 `handle-unlock` prints, but
  // Per-block sync only covers blocks near the chain tip.
  coinbase: false,
  token_transfer: false,
  tenure_change: false,
  poison_microblock: false,
};

interface ContractMetrics {
  readonly events: Metric.Metric<number, Metric.CounterState<number>>;
  readonly block: Metric.Metric<number, Metric.GaugeState<number>>;
}

function makeContractMetrics(filter: SyncFilter): ContractMetrics {
  const attributes = contractAttributes(filter.name, filter.contractId);

  return {
    events: Metric.withAttributes(syncEvents, { ...attributes, path: "block" }),
    block: Metric.withAttributes(syncBlockGauge, attributes),
  };
}

/** Per-contract series, labelled once per contract rather than once per block. */
const contractMetrics = new Map<string, ContractMetrics>();

function getContractMetrics(filter: SyncFilter) {
  const key = `${filter.name}\u0000${filter.contractId}`;
  let metrics = contractMetrics.get(key);

  if (metrics === undefined) {
    metrics = makeContractMetrics(filter);
    contractMetrics.set(key, metrics);
  }

  return metrics;
}

/** Per-block-source sync gauges, labelled once per source. */
const blockSourceGauges = new Map<string, Metric.Metric<number, Metric.GaugeState<number>>>();

function getBlockSourceGauge(name: string) {
  let gauge = blockSourceGauges.get(name);

  if (gauge === undefined) {
    gauge = Metric.withAttributes(syncBlockGauge, blockSourceAttributes(name));
    blockSourceGauges.set(name, gauge);
  }

  return gauge;
}

/**
 * Estimates the requests a per-block fetch of `block` costs: its transaction
 * pages plus one events page per transaction. Transactions that cannot hold
 * logs cost none and those with more than `TRANSACTION_EVENTS_PAGE_LIMIT`
 * events cost more, which the estimate ignores.
 */
export function estimateBlockRequests(block: LightBlock): number {
  return Math.ceil(Math.max(block.txCount, 1) / BLOCK_TRANSACTIONS_PAGE_LIMIT) + block.txCount;
}

/** Every transaction of the block, in block order. */
function fetchBlockTransactions(
  block: LightBlock,
): Effect.Effect<BlockTransaction[], StacksApiError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    const transactions: BlockTransaction[] = [];
    let cursor: string | undefined = undefined;

    for (;;) {
      const page: BlockTransactionsApiResponse = yield* client.getBlockTransactions(block.hash, {
        limit: BLOCK_TRANSACTIONS_PAGE_LIMIT,
        cursor,
      });

      transactions.push(...page.results);

      if (page.cursor.next === null) {
        break;
      }

      cursor = page.cursor.next;
    }

    return transactions.toSorted((a, b) => a.block.tx_index - b.block.tx_index);
  });
}

/** The transaction's smart contract logs emitted by one of `contractIds`. */
function fetchTransactionLogs(
  txId: string,
  contractIds: ReadonlySet<string>,
): Effect.Effect<SmartContractLogEvent[], StacksApiError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    const logs: SmartContractLogEvent[] = [];
    let cursor: string | undefined = undefined;

    for (;;) {
      const page: TransactionEventsResponse = yield* client.getTransactionEvents(txId, {
        limit: TRANSACTION_EVENTS_PAGE_LIMIT,
        cursor,
      });

      for (const event of page.results) {
        if (event.type === "contract_log" && contractIds.has(event.contract_log.contract_id)) {
          logs.push({
            event_index: event.event_index,
            event_type: "smart_contract_log",
            tx_id: txId,
            contract_log: event.contract_log,
          });
        }
      }

      if (page.cursor.next === null) {
        break;
      }

      cursor = page.cursor.next;
    }

    return logs;
  });
}

/**
 * The data needed to store `block`: from a transaction of the block, else
 * from its `/extended/v2/blocks` row when it came with one, else fetched.
 */
function getStorableBlock(
  block: LightBlock,
  transaction: StorableTransaction | undefined,
): Effect.Effect<StorableBlock, StacksApiError, StacksClient> {
  if (transaction !== undefined) {
    return Effect.succeed({
      height: block.height,
      hash: block.hash,
      index_block_hash: transaction.block.index_hash,
      burn_block_time: transaction.bitcoin_block.time,
      burn_block_height: transaction.bitcoin_block.height,
    });
  }

  if (block.stored !== undefined) {
    return Effect.succeed(block.stored);
  }

  return Effect.gen(function* () {
    const client = yield* StacksClient;

    return yield* client.getBlock(block.hash);
  });
}

/**
 * Whether storing `block` for a block source running at it costs a request:
 * its `/extended/v2/blocks` row is missing, and no transaction may provide it.
 */
export function needsBlockRequest(
  block: LightBlock,
  blockSources: readonly BlockSyncFilter[],
): boolean {
  return (
    block.stored === undefined &&
    blockSources.some((source) => isBlockSourceHeight(source, block.height))
  );
}

/**
 * Fetches every smart contract log `block` holds for the filters' contracts
 * and stores it with its transaction and block, as a contract-log sync would.
 * The block is also stored when a block source runs at it. Every filter and
 * block source syncing at `block.height` is then synced through it, in the
 * same transaction. Returns the number of stored events.
 *
 * Only successful transactions with events of a type that may hold logs are
 * queried: the API keeps no events for aborted ones, matching the contract
 * logs endpoint, and `MAY_HOLD_LOGS` rules out the types that never print.
 * Without a syncing contract, no transaction is fetched.
 */
export function syncBlock(options: {
  readonly chainId: number;
  readonly block: LightBlock;
  readonly filters: readonly SyncFilter[];
  readonly blockSources?: readonly BlockSyncFilter[];
}): Effect.Effect<
  number,
  StacksApiError | SyncStoreError | DatabaseError,
  StacksClient | IndexerDatabase
> {
  const { chainId, block } = options;

  return Effect.gen(function* () {
    const syncing = options.filters.filter(
      (filter) =>
        (filter.startBlock === undefined || filter.startBlock <= block.height) &&
        (filter.endBlock === undefined || filter.endBlock >= block.height),
    );

    const syncingSources = (options.blockSources ?? []).filter(
      (source) => source.endBlock === undefined || source.endBlock >= block.height,
    );

    const contractIds = new Set(syncing.map((filter) => filter.contractId));
    const transactions = contractIds.size === 0 ? [] : yield* fetchBlockTransactions(block);

    const logsByTransaction = yield* Effect.forEach(
      transactions.filter(
        (transaction) =>
          transaction.status === "success" &&
          transaction.event_count > 0 &&
          MAY_HOLD_LOGS[transaction.type],
      ),
      (transaction) =>
        fetchTransactionLogs(transaction.tx_id, contractIds).pipe(
          Effect.map((logs) => ({ transaction, logs })),
        ),
      { concurrency: EVENTS_FETCH_CONCURRENCY },
    );

    const matched = logsByTransaction.filter(({ logs }) => logs.length > 0);

    const events = matched.flatMap(({ logs }) =>
      logs.map((event) => ({ event, blockHeight: block.height })),
    );

    const [first] = matched;

    const isSourceBlock = syncingSources.some((source) =>
      isBlockSourceHeight(source, block.height),
    );

    const storable =
      first !== undefined || isSourceBlock
        ? yield* getStorableBlock(block, first?.transaction ?? transactions[0])
        : undefined;

    yield* IndexerDatabase.transaction(() =>
      Effect.gen(function* () {
        if (storable !== undefined) {
          yield* syncStore.insertBlocks({ chainId, blocks: [storable] });
        }

        if (first !== undefined) {
          yield* syncStore.insertTransactions({
            chainId,
            transactions: matched.map(({ transaction }) => transaction),
          });
          yield* syncStore.insertEvents({ chainId, events });
        }

        yield* syncStore.raiseSyncedBlockHeight({
          chainId,
          contractIds: [...contractIds],
          blockHeight: block.height,
        });
        yield* syncStore.raiseBlockSyncedBlockHeight({
          chainId,
          sources: syncingSources,
          blockHeight: block.height,
        });
      }),
    );

    const eventsByContract = new Map<string, number>();

    for (const { logs } of matched) {
      for (const log of logs) {
        const contract = log.contract_log.contract_id;
        eventsByContract.set(contract, (eventsByContract.get(contract) ?? 0) + 1);
      }
    }

    for (const filter of syncing) {
      const metrics = getContractMetrics(filter);
      const count = eventsByContract.get(filter.contractId);

      if (count !== undefined) {
        yield* Metric.update(metrics.events, count);
      }

      // Live blocks sit above the anchor, which no syncing contract has passed,
      // So the raise above moved every syncing contract to this block.
      yield* Metric.update(metrics.block, block.height);
    }

    // A source starting above this block keeps its higher synced height.
    for (const source of syncingSources) {
      if (source.startBlock <= block.height) {
        yield* Metric.update(getBlockSourceGauge(source.name), block.height);
      }
    }

    return events.length;
  });
}
