import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { migrate } from "../database/index.ts";
import type { StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type BlockApiResponse,
  type SmartContractLogEvent,
  type TransactionApiResponse,
} from "../datasources/api/index.ts";
import { createIndexing } from "../indexing/index.ts";
import { chunkArray } from "../lib/array.ts";
import type { HandlerExecutionError } from "../lib/errors.ts";
import { startClock } from "../lib/timer.ts";
import type { EventHandler, HandlerEvent } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";
import { createHistoricalSync, parseLogsCursor } from "../sync-historical/index.ts";
import { syncStore } from "../sync-store/index.ts";

const BATCH_SIZE = 5;

export interface Filter {
  contractId: string;
  handler: EventHandler;
  startBlock?: number;
  endBlock?: number;
}

// oxlint-disable-next-line typescript/no-explicit-any
export interface HistoricalRuntimeContext<TSchema extends Record<string, unknown> = any> {
  logger: Logger;
  db: NodePgDatabase<TSchema> | PgliteDatabase<TSchema>;
  api?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

interface ContractSyncState {
  contractId: string;
  cursor: string | null;
  syncedBlockHeight?: number;
  isInitialPage?: boolean;
  done: boolean;
  startBlock?: number;
  endBlock?: number;
}

function getSafeBlockHeight(states: ContractSyncState[]): number | undefined {
  const activeStates = states.filter((state) => !state.done);
  if (activeStates.length === 0) {
    return undefined;
  }

  let minHeight: number | undefined = undefined;
  for (const state of activeStates) {
    if (state.syncedBlockHeight !== undefined) {
      if (minHeight === undefined || state.syncedBlockHeight < minHeight) {
        minHeight = state.syncedBlockHeight;
      }
    }
  }
  return minHeight;
}

async function initializeContractStates(
  filters: Filter[],
  context: HistoricalRuntimeContext,
): Promise<Result<ContractSyncState[], StacksApiError>> {
  const states: ContractSyncState[] = [];
  for (const filter of filters) {
    // oxlint-disable-next-line no-await-in-loop
    const saved = await syncStore.getSyncProgress(
      { contractId: filter.contractId, chainId: 1 },
      { db: context.db },
    );

    if (saved === null) {
      const historicalSync = createHistoricalSync(context);
      // oxlint-disable-next-line no-await-in-loop
      const cursorResult = await historicalSync.getContractEventsFirstCursor(filter.contractId, {
        startBlock: filter.startBlock,
      });
      if (cursorResult.isErr()) {
        return Result.err(cursorResult.error);
      }
      const cursor = cursorResult.value;
      if (cursor) {
        const cursorHeight = parseLogsCursor(cursor).blockHeight;
        if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
          context.logger.info({
            service: "historicalRuntime",
            msg: `First event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
          });
          states.push({
            contractId: filter.contractId,
            cursor: null,
            done: true,
            startBlock: filter.startBlock,
            endBlock: filter.endBlock,
          });
        } else {
          context.logger.info({
            service: "historicalRuntime",
            msg: `Starting sync for ${filter.contractId} from block ${cursorHeight}`,
          });
          states.push({
            contractId: filter.contractId,
            cursor,
            isInitialPage: true,
            done: false,
            startBlock: filter.startBlock,
            endBlock: filter.endBlock,
          });
        }
      } else {
        context.logger.info({
          service: "historicalRuntime",
          msg: `No events found for ${filter.contractId}, skipping`,
        });
        states.push({
          contractId: filter.contractId,
          cursor: null,
          done: true,
          startBlock: filter.startBlock,
          endBlock: filter.endBlock,
        });
      }
    } else {
      const savedHeight = parseLogsCursor(saved.cursor).blockHeight;
      if (filter.endBlock !== undefined && savedHeight > filter.endBlock) {
        context.logger.info({
          service: "historicalRuntime",
          msg: `Resumed cursor for ${filter.contractId} at block ${savedHeight} exceeds endBlock ${filter.endBlock}, marking done`,
        });
        states.push({
          contractId: filter.contractId,
          cursor: saved.cursor,
          done: true,
          startBlock: filter.startBlock,
          endBlock: filter.endBlock,
        });
      } else {
        context.logger.info({
          service: "historicalRuntime",
          msg: `Resuming sync for ${filter.contractId} from block ${savedHeight}`,
        });
        states.push({
          contractId: filter.contractId,
          cursor: saved.cursor,
          isInitialPage: false,
          done: false,
          startBlock: filter.startBlock,
          endBlock: filter.endBlock,
        });
      }
    }
  }
  return Result.ok(states);
}

export const createHistoricalRuntime = (context: HistoricalRuntimeContext) => {
  async function processEventsUpTo(
    toBlockHeight: number,
    indexing: ReturnType<typeof createIndexing>,
    filterMap: Map<string, Filter>,
  ): Promise<Result<void, StacksApiError | HandlerExecutionError>> {
    const checkpoint = await syncStore.getCheckpoint({ chainId: 1 }, { db: context.db });
    const fromBlockHeight = checkpoint ? Number(checkpoint.blockHeight) : 0;

    if (fromBlockHeight >= toBlockHeight) {
      return Result.ok(undefined);
    }

    const rows = await syncStore.getEvents(
      { chainId: 1, fromBlockHeight: fromBlockHeight + 1, toBlockHeight },
      { db: context.db },
    );

    if (rows.length === 0) {
      return Result.ok(undefined);
    }

    const toLabel = toBlockHeight === Number.MAX_SAFE_INTEGER ? "latest" : String(toBlockHeight);
    context.logger.info({
      service: "historicalRuntime",
      msg: `Indexing events from block ${fromBlockHeight + 1} to ${toLabel}`,
      count: rows.length,
    });

    const batchClock = startClock();

    for (const row of rows) {
      const filter = filterMap.get(row.contractId);
      const rowBlockHeight = Number(row.blockHeight);
      const isBeforeStart = filter?.startBlock !== undefined && rowBlockHeight < filter.startBlock;
      const isAfterEnd = filter?.endBlock !== undefined && rowBlockHeight > filter.endBlock;

      if (!isBeforeStart && !isAfterEnd) {
        const event: HandlerEvent = {
          event_index: row.eventIndex,
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          event_type: row.eventType as "smart_contract_log",
          tx_id: row.txId,
          contract_log: {
            contract_id: row.contractId,
            topic: row.topic,
            value: {
              hex: row.valueHex,
              repr: row.valueRepr,
            },
          },
          block_height: rowBlockHeight,
          block_time: Number(row.blockTime),
          tx_index: row.txIndex,
          sender_address: row.senderAddress,
        };
        // oxlint-disable-next-line no-await-in-loop
        const result = await indexing.executeEvent(event);
        if (result.isErr()) {
          return Result.err(result.error);
        }
      }
    }

    const lastRow = rows[rows.length - 1];
    // oxlint-disable-next-line no-await-in-loop
    await syncStore.upsertCheckpoint(
      {
        chainId: 1,
        blockHeight: Number(lastRow.blockHeight),
        blockTime: Number(lastRow.blockTime),
      },
      { db: context.db },
    );

    const batchDuration = batchClock();
    context.logger.info({
      service: "historicalRuntime",
      msg: `Indexed ${rows.length} events up to block ${Number(lastRow.blockHeight)}`,
      block: Number(lastRow.blockHeight),
      duration: batchDuration,
    });

    return Result.ok(undefined);
  }

  async function fetchMissingTransactions(
    txIds: string[],
    maxBlockHeight?: number,
  ): Promise<Result<TransactionApiResponse[], StacksApiError>> {
    const transactions: TransactionApiResponse[] = [];
    for (const chunk of chunkArray(txIds, BATCH_SIZE)) {
      // oxlint-disable-next-line no-await-in-loop
      const txResults = await Promise.all(
        chunk.map((txId) => datasourceStacksApi.getTransaction(context, txId)),
      );
      let exceededMaxHeight = false;
      for (const txResult of txResults) {
        if (txResult.isErr()) {
          return Result.err(txResult.error);
        }
        transactions.push(txResult.value);
        if (maxBlockHeight !== undefined && txResult.value.block.height > maxBlockHeight) {
          exceededMaxHeight = true;
        }
      }
      if (exceededMaxHeight) {
        break;
      }
    }
    return Result.ok(transactions);
  }

  async function fetchMissingBlocks(
    transactions: TransactionApiResponse[],
  ): Promise<Result<BlockApiResponse[], StacksApiError>> {
    const blockHashes = [...new Set(transactions.map((transaction) => transaction.block.hash))];
    const existingBlockHashes = await syncStore.getExistingBlocks(
      { blockHashes, chainId: 1 },
      { db: context.db },
    );
    const missingBlockHashes = blockHashes.filter((hash) => !existingBlockHashes.includes(hash));
    context.logger.debug({
      service: "historicalRuntime",
      msg: `Blocks: ${blockHashes.length} total, ${missingBlockHashes.length} missing`,
    });

    const blocks: BlockApiResponse[] = [];
    for (const chunk of chunkArray(missingBlockHashes, BATCH_SIZE)) {
      // oxlint-disable-next-line no-await-in-loop
      const blockResults = await Promise.all(
        chunk.map((hash) => datasourceStacksApi.getBlock(context, hash)),
      );
      for (const blockResult of blockResults) {
        if (blockResult.isErr()) {
          return Result.err(blockResult.error);
        }
        blocks.push(blockResult.value);
      }
    }
    return Result.ok(blocks);
  }

  async function advanceContractSyncState(
    lowestState: ContractSyncState,
    currentHeight: number,
    nextCursor: string | null,
  ): Promise<void> {
    const wasInitialPage = lowestState.isInitialPage ?? false;
    lowestState.isInitialPage = false;
    lowestState.syncedBlockHeight = currentHeight - 1;

    if (nextCursor) {
      const lastBlockHeight = parseLogsCursor(nextCursor).blockHeight;
      const isPastEndBlock =
        lowestState.endBlock !== undefined &&
        (currentHeight > lowestState.endBlock ||
          (!wasInitialPage && currentHeight >= lowestState.endBlock));

      if (isPastEndBlock) {
        context.logger.info({
          service: "historicalRuntime",
          msg: `Sync reached endBlock ${lowestState.endBlock} for ${lowestState.contractId}`,
        });
        lowestState.done = true;
      } else {
        await syncStore.upsertSyncProgress(
          {
            contractId: lowestState.contractId,
            chainId: 1,
            cursor: nextCursor,
            lastBlockHeight,
          },
          { db: context.db },
        );
        lowestState.cursor = nextCursor;
      }
    } else {
      context.logger.info({
        service: "historicalRuntime",
        msg: `Sync complete for ${lowestState.contractId}`,
      });
      lowestState.done = true;
    }
  }

  return {
    async run(filters: Filter[]): Promise<Result<void, StacksApiError | HandlerExecutionError>> {
      if (filters.length === 0) {
        return Result.ok(undefined);
      }

      await migrate(context.db);

      const runClock = startClock();

      context.logger.info({
        service: "historicalRuntime",
        msg: `Starting historical indexer for ${filters.length} contract(s)`,
      });

      const filterMap = new Map<string, Filter>();
      const handlers: Record<string, EventHandler | undefined> = {};
      for (const filter of filters) {
        handlers[filter.contractId] = filter.handler;
        filterMap.set(filter.contractId, filter);
      }
      const indexing = createIndexing({
        logger: context.logger,
        db: context.db,
        handlers,
        api: context.api,
      });

      const statesResult = await initializeContractStates(filters, context);
      if (statesResult.isErr()) {
        return Result.err(statesResult.error);
      }
      const states = statesResult.value;

      while (states.some((state) => !state.done)) {
        // Find contract with lowest block height cursor
        let lowestState: ContractSyncState | null = null;
        let lowestHeight = Number.MAX_SAFE_INTEGER;

        for (const state of states) {
          if (!state.done && state.cursor !== null) {
            const height = parseLogsCursor(state.cursor).blockHeight;
            if (height < lowestHeight) {
              lowestHeight = height;
              lowestState = state;
            }
          }
        }

        // All contracts done
        if (!lowestState || lowestState.cursor === null) {
          break;
        }

        // Fetch one page of events
        // oxlint-disable-next-line no-await-in-loop
        const logsResult = await datasourceStacksApi.getContractLogs(
          context,
          lowestState.contractId,
          { cursor: lowestState.cursor },
        );
        if (logsResult.isErr()) {
          return Result.err(logsResult.error);
        }

        const { results: events, next_cursor: nextCursor } = logsResult.value;
        const currentHeight = parseLogsCursor(lowestState.cursor).blockHeight;
        context.logger.info({
          service: "historicalRuntime",
          msg: `Syncing ${lowestState.contractId}`,
          block: currentHeight,
          events: events.length,
        });

        // Batch fetch transactions (deduplicated by tx_id) in chronological order
        const txIds = [
          ...new Set(
            events
              .slice()
              .reverse()
              .map((event) => event.tx_id),
          ),
        ];
        // oxlint-disable-next-line no-await-in-loop
        const existingTxIds = await syncStore.getExistingTransactions(
          { txIds, chainId: 1 },
          { db: context.db },
        );
        const missingTxIds = txIds.filter((txId) => !existingTxIds.includes(txId));
        context.logger.debug({
          service: "historicalRuntime",
          msg: `Transactions: ${txIds.length} total, ${missingTxIds.length} missing`,
        });

        // oxlint-disable-next-line no-await-in-loop
        const txResult = await fetchMissingTransactions(missingTxIds, lowestState.endBlock);
        if (txResult.isErr()) {
          return Result.err(txResult.error);
        }
        const transactions = txResult.value;

        // oxlint-disable-next-line no-await-in-loop
        const blockResult = await fetchMissingBlocks(transactions);
        if (blockResult.isErr()) {
          return Result.err(blockResult.error);
        }
        const blocks = blockResult.value;

        // Store blocks, transactions, and events
        // Only smart_contract_log events have a `value` field; skip other event types.
        const smartContractLogs = events.filter(
          // oxlint-disable-next-line typescript/no-unnecessary-condition
          (event): event is SmartContractLogEvent => event.event_type === "smart_contract_log",
        );
        const txMap = new Map(transactions.map((transaction) => [transaction.tx_id, transaction]));
        const eventsWithBlockHeight = smartContractLogs
          .map((event) => {
            const tx = txMap.get(event.tx_id);
            return { event, blockHeight: tx?.block.height ?? 0 };
          })
          .filter((item) => item.blockHeight > 0);

        const chainId = 1;

        // oxlint-disable-next-line no-await-in-loop
        await context.db.transaction(async (tx) => {
          await Promise.all([
            syncStore.insertBlocks({ blocks, chainId }, { db: tx }),
            syncStore.insertTransactions({ transactions, chainId }, { db: tx }),
            syncStore.insertEvents({ events: eventsWithBlockHeight, chainId }, { db: tx }),
          ]);
        });

        // oxlint-disable-next-line no-await-in-loop
        await advanceContractSyncState(lowestState, currentHeight, nextCursor);

        // Incremental indexing: process all events up to the safe block height
        const safeHeight = getSafeBlockHeight(states);
        if (safeHeight !== undefined) {
          // oxlint-disable-next-line no-await-in-loop
          const indexResult = await processEventsUpTo(safeHeight, indexing, filterMap);
          if (indexResult.isErr()) {
            return Result.err(indexResult.error);
          }
        }
      }

      // Final indexing pass: process all remaining events
      // oxlint-disable-next-line no-await-in-loop
      const finalIndexResult = await processEventsUpTo(
        Number.MAX_SAFE_INTEGER,
        indexing,
        filterMap,
      );
      if (finalIndexResult.isErr()) {
        return Result.err(finalIndexResult.error);
      }

      const runDuration = runClock();
      context.logger.info({
        service: "historicalRuntime",
        msg: "Historical indexing complete",
        duration: runDuration,
      });

      return Result.ok(undefined);
    },
  };
};
