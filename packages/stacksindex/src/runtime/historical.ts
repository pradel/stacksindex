import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type BlockApiResponse,
  type ContractEvent,
  type DatasourceStacksApiContext,
  type TransactionApiResponse,
} from "../datasources/api/index.ts";
import { decodeClarityValueUnwrapped } from "../indexing/clarity.ts";
import { createIndexing } from "../indexing/index.ts";
import { chunkArray } from "../lib/array.ts";
import type { HandlerExecutionError } from "../lib/errors.ts";
import { startClock } from "../lib/timer.ts";
import {
  type EventHandler,
  type Filter,
  type FilterBounds,
  type HandlerEvent,
  type IndexingClient,
  resolveNetwork,
} from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";
import { createHistoricalSync, parseCursor } from "../sync-historical/index.ts";
import { syncStore } from "../sync-store/index.ts";
import { migrate } from "../sync-store/migrate.ts";

const BATCH_SIZE = 5;

export interface HistoricalRuntimeContext {
  logger: Logger;
  db: NodePgDatabase | PgliteDatabase;
  /** Target network. Defaults to `"mainnet"`. */
  network?: "mainnet" | "testnet" | { url: string; chainId?: number };
  /** Optional Hiro API key, sent as the `x-api-key` header. */
  apiKey?: string;
}

interface ContractSyncState {
  contractId: string;
  cursor: string;
  done: boolean;
}

type RunError = StacksApiError | HandlerExecutionError;

interface RuntimeDatasourceContext extends DatasourceStacksApiContext {
  db: NodePgDatabase | PgliteDatabase;
}

function getSafeBlockHeight(states: ContractSyncState[]): number {
  let minHeight = parseCursor(states[0].cursor).blockHeight;
  for (const state of states.slice(1)) {
    const height = parseCursor(state.cursor).blockHeight;
    if (height < minHeight) {
      minHeight = height;
    }
  }
  return minHeight - 1;
}

function pickLowestCursorState(states: ContractSyncState[]): ContractSyncState {
  let [lowest] = states;
  let lowestHeight = parseCursor(lowest.cursor).blockHeight;
  for (const state of states.slice(1)) {
    const height = parseCursor(state.cursor).blockHeight;
    if (height < lowestHeight) {
      lowest = state;
      lowestHeight = height;
    }
  }
  return lowest;
}

async function initializeContractStates(
  filters: Filter[],
  chainId: number,
  historicalSync: ReturnType<typeof createHistoricalSync>,
  dsContext: RuntimeDatasourceContext,
  logger: Logger,
): Promise<Result<ContractSyncState[], StacksApiError>> {
  const states: ContractSyncState[] = [];
  for (const filter of filters) {
    // oxlint-disable-next-line no-await-in-loop
    const saved = await syncStore.getSyncProgress(
      { contractId: filter.contractId, chainId },
      { db: dsContext.db },
    );

    if (saved === null) {
      // oxlint-disable-next-line no-await-in-loop
      const cursorResult = await historicalSync.getContractEventsFirstCursor(filter.contractId);
      if (cursorResult.isErr()) {
        return Result.err(cursorResult.error);
      }
      const cursor = cursorResult.value;
      if (cursor) {
        logger.info({
          service: "historicalRuntime",
          msg: `Starting sync for ${filter.contractId} from block ${parseCursor(cursor).blockHeight}`,
        });
        states.push({ contractId: filter.contractId, cursor, done: false });
      } else {
        logger.info({
          service: "historicalRuntime",
          msg: `No events found for ${filter.contractId}, skipping`,
        });
      }
    } else {
      logger.info({
        service: "historicalRuntime",
        msg: `Resuming sync for ${filter.contractId} from block ${parseCursor(saved.cursor).blockHeight}`,
      });
      states.push({ contractId: filter.contractId, cursor: saved.cursor, done: false });
    }
  }
  return Result.ok(states);
}

export const createHistoricalRuntime = (context: HistoricalRuntimeContext) => {
  // Chain tip (block height) that read-only calls are evaluated against.
  // Updated per event during processing; undefined outside a run.
  let currentTipBlockHeight: number | undefined = undefined;

  async function processEventsUpTo(
    toBlockHeight: number,
    chainId: number,
    indexing: ReturnType<typeof createIndexing>,
  ): Promise<Result<void, RunError>> {
    const checkpoint = await syncStore.getCheckpoint({ chainId }, { db: context.db });
    const fromBlockHeight = checkpoint ? Number(checkpoint.blockHeight) : 0;

    if (fromBlockHeight >= toBlockHeight) {
      return Result.ok(undefined);
    }

    const rows = await syncStore.getEvents(
      { chainId, fromBlockHeight: fromBlockHeight + 1, toBlockHeight },
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
        block_height: Number(row.blockHeight),
        block_time: Number(row.blockTime),
        tx_index: row.txIndex,
        sender_address: row.senderAddress,
        decoded: decodeClarityValueUnwrapped(row.valueHex),
      };
      // Pin read-only calls to the state at the block being processed so
      // That handler reads stay deterministic across runs.
      currentTipBlockHeight = event.block_height;
      // oxlint-disable-next-line no-await-in-loop
      const result = await indexing.executeEvent(event);
      if (result.isErr()) {
        return Result.err(result.error);
      }
    }

    const lastRow = rows[rows.length - 1];
    // oxlint-disable-next-line no-await-in-loop
    await syncStore.upsertCheckpoint(
      {
        chainId,
        blockHeight: Number(lastRow.blockHeight),
        blockTime: Number(lastRow.blockTime),
      },
      { db: context.db },
    );

    context.logger.info({
      service: "historicalRuntime",
      msg: `Indexed ${rows.length} events up to block ${Number(lastRow.blockHeight)}`,
      block: Number(lastRow.blockHeight),
      duration: batchClock(),
    });

    return Result.ok(undefined);
  }

  async function fetchMissingTransactions(
    txIds: string[],
    dsContext: DatasourceStacksApiContext,
  ): Promise<Result<TransactionApiResponse[], StacksApiError>> {
    const transactions: TransactionApiResponse[] = [];
    for (const chunk of chunkArray(txIds, 50)) {
      // oxlint-disable-next-line no-await-in-loop
      const txsResult = await datasourceStacksApi.getTransactions(dsContext, chunk);
      if (txsResult.isErr()) {
        return Result.err(txsResult.error);
      }
      transactions.push(...txsResult.value);
    }
    return Result.ok(transactions);
  }

  async function fetchMissingBlocks(
    blockHashes: string[],
    dsContext: DatasourceStacksApiContext,
  ): Promise<Result<BlockApiResponse[], StacksApiError>> {
    const blocks: BlockApiResponse[] = [];
    for (const chunk of chunkArray(blockHashes, BATCH_SIZE)) {
      // oxlint-disable-next-line no-await-in-loop
      const blockResults = await Promise.all(
        chunk.map((hash) => datasourceStacksApi.getBlockByHash(dsContext, hash)),
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

  async function storePage(
    events: ContractEvent[],
    chainId: number,
    dsContext: RuntimeDatasourceContext,
  ): Promise<Result<void, RunError>> {
    // Batch fetch transactions (deduplicated by tx_id)
    const txIds = [...new Set(events.map((event) => event.tx_id))];
    // oxlint-disable-next-line no-await-in-loop
    const existingTxIds = await syncStore.getExistingTransactions(
      { txIds, chainId },
      { db: dsContext.db },
    );
    const missingTxIds = txIds.filter((txId) => !existingTxIds.includes(txId));
    context.logger.debug({
      service: "historicalRuntime",
      msg: `Transactions: ${txIds.length} total, ${missingTxIds.length} missing`,
    });

    // oxlint-disable-next-line no-await-in-loop
    const txResult = await fetchMissingTransactions(missingTxIds, dsContext);
    if (txResult.isErr()) {
      return Result.err(txResult.error);
    }
    const transactions = txResult.value;

    // Batch fetch blocks (deduplicated by block_hash)
    const blockHashes = [...new Set(transactions.map((transaction) => transaction.block_hash))];
    // oxlint-disable-next-line no-await-in-loop
    const existingBlockHashes = await syncStore.getExistingBlocks(
      { blockHashes, chainId },
      { db: dsContext.db },
    );
    const missingBlockHashes = blockHashes.filter((hash) => !existingBlockHashes.includes(hash));
    context.logger.debug({
      service: "historicalRuntime",
      msg: `Blocks: ${blockHashes.length} total, ${missingBlockHashes.length} missing`,
    });

    // oxlint-disable-next-line no-await-in-loop
    const blocksResult = await fetchMissingBlocks(missingBlockHashes, dsContext);
    if (blocksResult.isErr()) {
      return Result.err(blocksResult.error);
    }

    // Only smart_contract_log events carry a Clarity value; other event types are skipped.
    const smartContractLogs = events.filter((event) => event.event_type === "smart_contract_log");
    const eventsWithBlockHeight = smartContractLogs.map((event) => {
      const tx = transactions.find((transaction) => transaction.tx_id === event.tx_id);
      return { event, blockHeight: tx?.block_height ?? 0 };
    });

    // oxlint-disable-next-line no-await-in-loop
    await dsContext.db.transaction(async (tx) => {
      await Promise.all([
        syncStore.insertBlocks({ blocks: blocksResult.value, chainId }, { db: tx }),
        syncStore.insertTransactions({ transactions, chainId }, { db: tx }),
        syncStore.insertEvents({ events: eventsWithBlockHeight, chainId }, { db: tx }),
      ]);
    });

    return Result.ok(undefined);
  }

  return {
    async run(filters: Filter[]): Promise<Result<void, RunError>> {
      if (filters.length === 0) {
        return Result.ok(undefined);
      }

      const runClock = startClock();

      const network = resolveNetwork(context.network ?? "mainnet");
      const { chainId } = network;

      await migrate(context.db);

      const dsContext: RuntimeDatasourceContext = {
        logger: context.logger,
        baseUrl: network.baseUrl,
        apiKey: context.apiKey,
        db: context.db,
      };

      context.logger.info({
        service: "historicalRuntime",
        msg: `Starting historical indexer for ${filters.length} contract(s)`,
        baseUrl: network.baseUrl,
        chainId,
      });

      const handlers: Record<string, EventHandler | undefined> = {};
      const bounds: Record<string, FilterBounds | undefined> = {};
      for (const filter of filters) {
        handlers[filter.contractId] = filter.handler;
        bounds[filter.contractId] = {
          startBlock: filter.startBlock,
          endBlock: filter.endBlock,
        };
      }

      const client: IndexingClient = {
        callReadOnly: (contractId, functionName, options) => {
          // Pin to the block being processed; fall back to the caller's tip.
          const tip = currentTipBlockHeight ?? options?.tip;
          return datasourceStacksApi.callReadFunction(dsContext, contractId, functionName, {
            ...options,
            tip,
          });
        },
      };

      const indexing = createIndexing({
        logger: context.logger,
        db: context.db,
        client,
        handlers,
        bounds,
      });

      const statesResult = await initializeContractStates(
        filters,
        chainId,
        createHistoricalSync({ logger: context.logger }),
        dsContext,
        context.logger,
      );
      if (statesResult.isErr()) {
        return Result.err(statesResult.error);
      }
      const activeStates = statesResult.value;

      function removeActive(state: ContractSyncState): void {
        activeStates.splice(activeStates.indexOf(state), 1);
      }

      async function advanceLowestContract(): Promise<Result<boolean, RunError>> {
        const lowestState = pickLowestCursorState(activeStates);
        const { endBlock } = bounds[lowestState.contractId] ?? {};
        const currentHeight = parseCursor(lowestState.cursor).blockHeight;

        let finished = false;
        if (endBlock !== undefined && currentHeight > endBlock) {
          context.logger.info({
            service: "historicalRuntime",
            msg: `Reached end block for ${lowestState.contractId}`,
            endBlock,
          });
          finished = true;
        }

        if (!finished) {
          // Fetch one page of events.
          // oxlint-disable-next-line no-await-in-loop
          const logsResult = await datasourceStacksApi.getContractLogs(
            dsContext,
            lowestState.contractId,
            { cursor: lowestState.cursor },
          );
          if (logsResult.isErr()) {
            return Result.err(logsResult.error);
          }

          const { results: events, next_cursor: nextCursor } = logsResult.value;
          context.logger.info({
            service: "historicalRuntime",
            msg: `Syncing ${lowestState.contractId}`,
            block: currentHeight,
            events: events.length,
          });

          // oxlint-disable-next-line no-await-in-loop
          const storedResult = await storePage(events, chainId, dsContext);
          if (storedResult.isErr()) {
            return Result.err(storedResult.error);
          }

          if (nextCursor === null) {
            context.logger.info({
              service: "historicalRuntime",
              msg: `Sync complete for ${lowestState.contractId}`,
            });
            finished = true;
          } else {
            const lastBlockHeight = parseCursor(nextCursor).blockHeight;
            // oxlint-disable-next-line no-await-in-loop
            await syncStore.upsertSyncProgress(
              {
                contractId: lowestState.contractId,
                chainId,
                cursor: nextCursor,
                lastBlockHeight,
              },
              { db: context.db },
            );
            if (endBlock !== undefined && lastBlockHeight > endBlock) {
              context.logger.info({
                service: "historicalRuntime",
                msg: `Reached end block for ${lowestState.contractId}`,
                endBlock,
              });
              finished = true;
            } else {
              lowestState.cursor = nextCursor;
            }
          }
        }

        if (finished) {
          removeActive(lowestState);
        }

        // Incremental indexing: process all events up to the safe block height.
        // Bound the range by the tightest endBlock of the active contracts.
        if (activeStates.length > 0) {
          const safeHeight = getSafeBlockHeight(activeStates);
          const activeEndBlocks: number[] = [];
          for (const state of activeStates) {
            const stateBound = bounds[state.contractId]?.endBlock;
            if (stateBound !== undefined) {
              activeEndBlocks.push(stateBound);
            }
          }
          const bound =
            activeEndBlocks.length > 0 ? Math.min(...activeEndBlocks) : Number.MAX_SAFE_INTEGER;
          // oxlint-disable-next-line no-await-in-loop
          const indexResult = await processEventsUpTo(
            Math.min(safeHeight, bound),
            chainId,
            indexing,
          );
          if (indexResult.isErr()) {
            return Result.err(indexResult.error);
          }
        }

        return Result.ok(true);
      }

      // Main loop: pick the contract with the lowest cursor block height, fetch one page.
      while (activeStates.length > 0) {
        // oxlint-disable-next-line no-await-in-loop
        const advanced = await advanceLowestContract();
        if (advanced.isErr()) {
          return Result.err(advanced.error);
        }
      }

      // Final indexing pass: process all remaining events up to the tightest end block.
      const allEndBlocks: number[] = [];
      for (const filter of filters) {
        if (filter.endBlock !== undefined) {
          allEndBlocks.push(filter.endBlock);
        }
      }
      const finalHeight =
        allEndBlocks.length > 0 ? Math.min(...allEndBlocks) : Number.MAX_SAFE_INTEGER;
      // oxlint-disable-next-line no-await-in-loop
      const finalIndexResult = await processEventsUpTo(finalHeight, chainId, indexing);
      if (finalIndexResult.isErr()) {
        return Result.err(finalIndexResult.error);
      }

      context.logger.info({
        service: "historicalRuntime",
        msg: "Historical indexing complete",
        duration: runClock(),
      });

      return Result.ok(undefined);
    },
  };
};
