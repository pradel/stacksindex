import { Effect, Metric } from "effect";

import { IndexerDatabase } from "../database/index.ts";
import type { LightBlock } from "../datasources/api/heads.ts";
import {
  type BlockTransactionsApiResponse,
  type SmartContractLogEvent,
  type StacksApiError,
  StacksClient,
  type StorableTransaction,
  type TransactionEventsResponse,
} from "../datasources/api/index.ts";
import type { DatabaseError, SyncStoreError } from "../lib/errors.ts";
import { syncBlock as syncBlockGauge, syncEvents } from "../lib/metrics.ts";
import { syncStore } from "../sync-store/index.ts";
import type { SyncFilter } from "../sync/index.ts";

/** Max results per `GET /extended/v3/blocks/{hash}/transactions` page. */
const BLOCK_TRANSACTIONS_PAGE_LIMIT = 50;

/** Max results per `GET /extended/v3/transactions/{tx_id}/events` page. */
const TRANSACTION_EVENTS_PAGE_LIMIT = 100;

/** Transactions whose events are fetched concurrently within one block. */
const EVENTS_FETCH_CONCURRENCY = 4;

interface ContractMetrics {
  readonly events: Metric.Metric<number, Metric.CounterState<number>>;
  readonly block: Metric.Metric<number, Metric.GaugeState<number>>;
}

function makeContractMetrics(contract: string): ContractMetrics {
  return {
    events: Metric.withAttributes(syncEvents, { contract, path: "block" }),
    block: Metric.withAttributes(syncBlockGauge, { contract }),
  };
}

/** Per-contract series, labelled once per contract rather than once per block. */
const contractMetrics = new Map<string, ContractMetrics>();

function getContractMetrics(contract: string) {
  let metrics = contractMetrics.get(contract);

  if (metrics === undefined) {
    metrics = makeContractMetrics(contract);
    contractMetrics.set(contract, metrics);
  }

  return metrics;
}

/**
 * Requests a per-block fetch of `block` costs at least: its transaction pages
 * plus one events page per transaction. Transactions with more than
 * `TRANSACTION_EVENTS_PAGE_LIMIT` events cost more, which the estimate ignores.
 */
export function estimateBlockRequests(block: LightBlock): number {
  return Math.ceil(Math.max(block.txCount, 1) / BLOCK_TRANSACTIONS_PAGE_LIMIT) + block.txCount;
}

/** Every transaction of the block, in block order. */
function fetchBlockTransactions(
  block: LightBlock,
): Effect.Effect<StorableTransaction[], StacksApiError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    const transactions: StorableTransaction[] = [];
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
 * Fetches every smart contract log `block` holds for the filters' contracts
 * and stores it with its transaction and block, as a contract-log sync would.
 * Every filter syncing at `block.height` is then synced through it, in the
 * same transaction. Returns the number of stored events.
 *
 * Only successful transactions are queried: the API keeps no events for
 * aborted ones, matching the contract logs endpoint.
 */
export function syncBlock(options: {
  readonly chainId: number;
  readonly block: LightBlock;
  readonly filters: readonly SyncFilter[];
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

    const contractIds = new Set(syncing.map((filter) => filter.contractId));
    const transactions = yield* fetchBlockTransactions(block);

    const logsByTransaction = yield* Effect.forEach(
      transactions.filter((transaction) => transaction.status === "success"),
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

    yield* IndexerDatabase.transaction(() =>
      Effect.gen(function* () {
        const [first] = matched;

        if (first !== undefined) {
          yield* syncStore.insertBlocks({
            chainId,
            blocks: [
              {
                height: block.height,
                hash: block.hash,
                burn_block_time: first.transaction.bitcoin_block.time,
                burn_block_height: first.transaction.bitcoin_block.height,
              },
            ],
          });
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
      }),
    );

    const eventsByContract = new Map<string, number>();

    for (const { logs } of matched) {
      for (const log of logs) {
        const contract = log.contract_log.contract_id;
        eventsByContract.set(contract, (eventsByContract.get(contract) ?? 0) + 1);
      }
    }

    for (const contract of contractIds) {
      const metrics = getContractMetrics(contract);
      const count = eventsByContract.get(contract);

      if (count !== undefined) {
        yield* Metric.update(metrics.events, count);
      }

      // Live blocks sit above the anchor, which no syncing contract has passed,
      // So the raise above moved every syncing contract to this block.
      yield* Metric.update(metrics.block, block.height);
    }

    return events.length;
  });
}
