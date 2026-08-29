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
import { FilterValidationError, type HandlerExecutionError } from "../lib/errors.ts";
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
  endBlock?: number | "latest";
}

interface ResolvedFilter {
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

async function validateAndResolveFilters(
  filters: Filter[],
  context: HistoricalRuntimeContext,
): Promise<Result<ResolvedFilter[], StacksApiError | FilterValidationError>> {
  for (const filter of filters) {
    if (filter.startBlock !== undefined) {
      if (!Number.isInteger(filter.startBlock) || filter.startBlock < 0) {
        return Result.err(
          new FilterValidationError({
            message: `Validation failed: Invalid startBlock for '${filter.contractId}'. Got ${filter.startBlock}, expected a non-negative integer.`,
          }),
        );
      }
    }

    if (filter.endBlock !== undefined && filter.endBlock !== "latest") {
      if (!Number.isInteger(filter.endBlock) || filter.endBlock < 0) {
        return Result.err(
          new FilterValidationError({
            message: `Validation failed: Invalid endBlock for '${filter.contractId}'. Got ${filter.endBlock}, expected a non-negative integer or "latest".`,
          }),
        );
      }
    }
  }

  let latestBlockHeight: number | undefined = undefined;
  const hasLatestTag = filters.some((filter) => filter.endBlock === "latest");

  if (hasLatestTag) {
    const statusResult = await datasourceStacksApi.getStatus(context);
    if (statusResult.isErr()) {
      return Result.err(statusResult.error);
    }
    const chainTipHeight = statusResult.value.chain_tip?.block_height;
    if (chainTipHeight === undefined) {
      return Result.err(
        new FilterValidationError({
          message:
            "Validation failed: Unable to determine latest block height from API status response.",
        }),
      );
    }
    latestBlockHeight = chainTipHeight;
    context.logger.info({
      service: "historicalRuntime",
      msg: `Resolved "latest" endBlock to block height ${latestBlockHeight}`,
      latestBlockHeight,
    });
  }

  const resolvedFilters: ResolvedFilter[] = [];
  for (const filter of filters) {
    const resolvedEndBlock = filter.endBlock === "latest" ? latestBlockHeight : filter.endBlock;

    if (
      filter.startBlock !== undefined &&
      resolvedEndBlock !== undefined &&
      filter.startBlock > resolvedEndBlock
    ) {
      return Result.err(
        new FilterValidationError({
          message: `Validation failed: Start block (${filter.startBlock}) is after end block (${resolvedEndBlock}) for contract '${filter.contractId}'.`,
        }),
      );
    }

    resolvedFilters.push({
      contractId: filter.contractId,
      handler: filter.handler,
      startBlock: filter.startBlock,
      endBlock: resolvedEndBlock,
    });
  }

  return Result.ok(resolvedFilters);
}

async function initContractFromScratch(
  filter: ResolvedFilter,
  context: HistoricalRuntimeContext,
): Promise<Result<ContractSyncState, StacksApiError>> {
  const historicalSync = createHistoricalSync(context);
  const cursorResult = await historicalSync.getContractEventsFirstCursor(filter.contractId, {
    startBlock: filter.startBlock,
  });
  if (cursorResult.isErr()) {
    return Result.err(cursorResult.error);
  }
  const cursor = cursorResult.value;
  if (!cursor) {
    context.logger.info({
      service: "historicalRuntime",
      msg: `No events found for ${filter.contractId}, skipping`,
    });
    await syncStore.upsertSyncProgress(
      {
        contractId: filter.contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: filter.endBlock ?? 0,
        isComplete: filter.endBlock !== undefined,
      },
      { db: context.db },
    );
    return Result.ok({
      contractId: filter.contractId,
      cursor: null,
      syncedBlockHeight: filter.endBlock ?? 0,
      done: true,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    });
  }

  const cursorHeight = parseLogsCursor(cursor).blockHeight;
  if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
    context.logger.info({
      service: "historicalRuntime",
      msg: `First event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
    });
    await syncStore.upsertSyncProgress(
      {
        contractId: filter.contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: filter.endBlock,
        isComplete: true,
      },
      { db: context.db },
    );
    return Result.ok({
      contractId: filter.contractId,
      cursor: null,
      syncedBlockHeight: filter.endBlock,
      done: true,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    });
  }

  context.logger.info({
    service: "historicalRuntime",
    msg: `Starting sync for ${filter.contractId} from block ${cursorHeight}`,
  });
  return Result.ok({
    contractId: filter.contractId,
    cursor,
    isInitialPage: true,
    done: false,
    startBlock: filter.startBlock,
    endBlock: filter.endBlock,
  });
}

async function initContractFromSaved(
  filter: ResolvedFilter,
  saved: NonNullable<Awaited<ReturnType<typeof syncStore.getSyncProgress>>>,
  context: HistoricalRuntimeContext,
): Promise<Result<ContractSyncState, StacksApiError>> {
  const savedHeight = Number(saved.lastBlockHeight);
  const isAlreadyComplete =
    saved.isComplete && filter.endBlock !== undefined && savedHeight >= filter.endBlock;

  if (isAlreadyComplete) {
    context.logger.info({
      service: "historicalRuntime",
      msg: `Sync already completed for ${filter.contractId} (synced up to block ${savedHeight}), skipping`,
    });
    return Result.ok({
      contractId: filter.contractId,
      cursor: null,
      syncedBlockHeight: savedHeight,
      done: true,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    });
  }

  if (filter.endBlock !== undefined && savedHeight > filter.endBlock) {
    context.logger.info({
      service: "historicalRuntime",
      msg: `Resumed progress for ${filter.contractId} at block ${savedHeight} exceeds endBlock ${filter.endBlock}, marking done`,
    });
    return Result.ok({
      contractId: filter.contractId,
      cursor: saved.cursor,
      syncedBlockHeight: savedHeight,
      done: true,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    });
  }

  if (saved.cursor) {
    context.logger.info({
      service: "historicalRuntime",
      msg: `Resuming sync for ${filter.contractId} from block ${savedHeight}`,
    });
    return Result.ok({
      contractId: filter.contractId,
      cursor: saved.cursor,
      isInitialPage: false,
      done: false,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    });
  }

  const historicalSync = createHistoricalSync(context);
  const cursorResult = await historicalSync.getContractEventsFirstCursor(filter.contractId, {
    startBlock: Math.max(filter.startBlock ?? 0, savedHeight + 1),
  });
  if (cursorResult.isErr()) {
    return Result.err(cursorResult.error);
  }
  const cursor = cursorResult.value;
  if (!cursor) {
    await syncStore.upsertSyncProgress(
      {
        contractId: filter.contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: filter.endBlock ?? savedHeight,
        isComplete: filter.endBlock !== undefined,
      },
      { db: context.db },
    );
    return Result.ok({
      contractId: filter.contractId,
      cursor: null,
      syncedBlockHeight: filter.endBlock ?? savedHeight,
      done: true,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    });
  }

  const cursorHeight = parseLogsCursor(cursor).blockHeight;
  if (filter.endBlock !== undefined && cursorHeight > filter.endBlock) {
    context.logger.info({
      service: "historicalRuntime",
      msg: `Next event for ${filter.contractId} at block ${cursorHeight} exceeds endBlock ${filter.endBlock}, skipping`,
    });
    await syncStore.upsertSyncProgress(
      {
        contractId: filter.contractId,
        chainId: 1,
        cursor: null,
        lastBlockHeight: filter.endBlock,
        isComplete: true,
      },
      { db: context.db },
    );
    return Result.ok({
      contractId: filter.contractId,
      cursor: null,
      syncedBlockHeight: filter.endBlock,
      done: true,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    });
  }

  return Result.ok({
    contractId: filter.contractId,
    cursor,
    isInitialPage: true,
    done: false,
    startBlock: filter.startBlock,
    endBlock: filter.endBlock,
  });
}

async function initializeContractStates(
  filters: ResolvedFilter[],
  context: HistoricalRuntimeContext,
): Promise<Result<ContractSyncState[], StacksApiError>> {
  const states: ContractSyncState[] = [];
  for (const filter of filters) {
    const saved = await syncStore.getSyncProgress(
      { contractId: filter.contractId, chainId: 1 },
      { db: context.db },
    );

    const statePromise =
      saved === null
        ? initContractFromScratch(filter, context)
        : initContractFromSaved(filter, saved, context);
    const stateResult = await statePromise;

    if (stateResult.isErr()) {
      return Result.err(stateResult.error);
    }
    states.push(stateResult.value);
  }
  return Result.ok(states);
}

export const createHistoricalRuntime = (context: HistoricalRuntimeContext) => {
  async function processEventsUpTo(
    toBlockHeight: number,
    indexing: ReturnType<typeof createIndexing>,
    filterMap: Map<string, ResolvedFilter>,
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
        const result = await indexing.executeEvent(event);
        if (result.isErr()) {
          return Result.err(result.error);
        }
      }
    }

    const lastRow = rows[rows.length - 1];
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
      const txResults = await Promise.all(
        chunk.map((txId) => datasourceStacksApi.getTransaction(context, txId)),
      );
      let exceededMaxHeight = false;
      for (const txResult of txResults) {
        if (txResult.isErr()) {
          return Result.err(txResult.error);
        }
        if (maxBlockHeight !== undefined && txResult.value.block.height > maxBlockHeight) {
          exceededMaxHeight = true;
        } else {
          transactions.push(txResult.value);
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
      const { endBlock } = lowestState;
      const isPastEndBlock =
        endBlock !== undefined &&
        (currentHeight > endBlock || (!wasInitialPage && currentHeight >= endBlock));

      if (endBlock !== undefined && isPastEndBlock) {
        context.logger.info({
          service: "historicalRuntime",
          msg: `Sync reached endBlock ${endBlock} for ${lowestState.contractId}`,
        });
        await syncStore.upsertSyncProgress(
          {
            contractId: lowestState.contractId,
            chainId: 1,
            cursor: null,
            lastBlockHeight: endBlock,
            isComplete: true,
          },
          { db: context.db },
        );
        lowestState.done = true;
      } else {
        await syncStore.upsertSyncProgress(
          {
            contractId: lowestState.contractId,
            chainId: 1,
            cursor: nextCursor,
            lastBlockHeight,
            isComplete: false,
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
      await syncStore.upsertSyncProgress(
        {
          contractId: lowestState.contractId,
          chainId: 1,
          cursor: null,
          lastBlockHeight: currentHeight,
          isComplete: lowestState.endBlock !== undefined,
        },
        { db: context.db },
      );
      lowestState.done = true;
    }
  }

  return {
    async run(
      filters: Filter[],
    ): Promise<Result<void, StacksApiError | HandlerExecutionError | FilterValidationError>> {
      if (filters.length === 0) {
        return Result.ok(undefined);
      }

      const validationResult = await validateAndResolveFilters(filters, context);
      if (validationResult.isErr()) {
        return Result.err(validationResult.error);
      }
      const resolvedFilters = validationResult.value;

      await migrate(context.db);

      const runClock = startClock();
      context.logger.info({
        service: "historicalRuntime",
        msg: "Starting historical indexing",
        contracts: resolvedFilters.map((filter) => filter.contractId),
      });

      const filterMap = new Map(resolvedFilters.map((filter) => [filter.contractId, filter]));
      const handlers: Record<string, EventHandler | undefined> = {};
      for (const filter of resolvedFilters) {
        handlers[filter.contractId] = filter.handler;
      }
      const indexing = createIndexing({
        logger: context.logger,
        db: context.db,
        handlers,
        api: context.api,
      });

      const statesResult = await initializeContractStates(resolvedFilters, context);
      if (statesResult.isErr()) {
        return Result.err(statesResult.error);
      }
      const states = statesResult.value;

      while (states.some((state) => !state.done)) {
        // Fair scheduling: find contract with lowest cursor block height
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
        const existingTxs = await syncStore.getExistingTransactions(
          { txIds, chainId: 1 },
          { db: context.db },
        );
        const existingTxIds = new Set(existingTxs.map((tx) => tx.txId));
        const missingTxIds = txIds.filter((txId) => !existingTxIds.has(txId));
        context.logger.debug({
          service: "historicalRuntime",
          msg: `Transactions: ${txIds.length} total, ${missingTxIds.length} missing`,
        });

        const txResult = await fetchMissingTransactions(missingTxIds, lowestState.endBlock);
        if (txResult.isErr()) {
          return Result.err(txResult.error);
        }
        const transactions = txResult.value;

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
        const txBlockHeights = new Map<string, number>();
        for (const existingTx of existingTxs) {
          txBlockHeights.set(existingTx.txId, Number(existingTx.blockHeight));
        }
        for (const transaction of transactions) {
          txBlockHeights.set(transaction.tx_id, transaction.block.height);
        }
        const eventsWithBlockHeight = smartContractLogs
          .map((event) => {
            const blockHeight = txBlockHeights.get(event.tx_id) ?? 0;
            return { event, blockHeight };
          })
          .filter((item) => item.blockHeight > 0);

        const chainId = 1;

        await context.db.transaction(async (tx) => {
          await Promise.all([
            syncStore.insertBlocks({ blocks, chainId }, { db: tx }),
            syncStore.insertTransactions({ transactions, chainId }, { db: tx }),
            syncStore.insertEvents({ events: eventsWithBlockHeight, chainId }, { db: tx }),
          ]);
        });

        await advanceContractSyncState(lowestState, currentHeight, nextCursor);

        // Incremental indexing: process all events up to the safe block height
        const safeHeight = getSafeBlockHeight(states);
        if (safeHeight !== undefined) {
          const indexResult = await processEventsUpTo(safeHeight, indexing, filterMap);
          if (indexResult.isErr()) {
            return Result.err(indexResult.error);
          }
        }
      }

      // Final indexing pass: process all remaining events
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
