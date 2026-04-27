import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type BlockApiResponse,
  type TransactionApiResponse,
} from "../datasources/api/index.ts";
import { createIndexing } from "../indexing/index.ts";
import { chunkArray } from "../lib/array.ts";
import type { HandlerExecutionError } from "../lib/errors.ts";
import type { EventHandler, HandlerEvent } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";
import { createHistoricalSync, parseCursor } from "../sync-historical/index.ts";
import { syncStore } from "../sync-store/index.ts";

const BATCH_SIZE = 5;

export interface Filter {
  contractId: string;
  handler: EventHandler;
}

export interface HistoricalRuntimeContext {
  logger: Logger;
  db: NodePgDatabase | PgliteDatabase;
}

interface ContractSyncState {
  contractId: string;
  cursor: string | null;
  done: boolean;
}

function getSafeBlockHeight(states: ContractSyncState[]): number | undefined {
  const activeStates = states.filter(
    (state): state is ContractSyncState & { cursor: string } =>
      !state.done && state.cursor !== null,
  );
  if (activeStates.length === 0) {
    return undefined;
  }

  let minHeight = parseCursor(activeStates[0].cursor).blockHeight;
  for (const state of activeStates.slice(1)) {
    const height = parseCursor(state.cursor).blockHeight;
    if (height < minHeight) {
      minHeight = height;
    }
  }
  return minHeight - 1;
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
      const cursorResult = await historicalSync.getContractEventsFirstCursor(filter.contractId);
      if (cursorResult.isErr()) {
        return Result.err(cursorResult.error);
      }
      const cursor = cursorResult.value;
      if (cursor) {
        context.logger.debug({
          service: "historicalRuntime",
          msg: `Starting sync for ${filter.contractId} from cursor ${cursor}`,
        });
        states.push({ contractId: filter.contractId, cursor, done: false });
      } else {
        context.logger.debug({
          service: "historicalRuntime",
          msg: `No events found for ${filter.contractId}`,
        });
        states.push({ contractId: filter.contractId, cursor: null, done: true });
      }
    } else {
      context.logger.debug({
        service: "historicalRuntime",
        msg: `Resuming sync for ${filter.contractId} from cursor ${saved.cursor}`,
      });
      states.push({ contractId: filter.contractId, cursor: saved.cursor, done: false });
    }
  }
  return Result.ok(states);
}

export const createHistoricalRuntime = (context: HistoricalRuntimeContext) => {
  async function processEventsUpTo(
    toBlockHeight: number,
    indexing: ReturnType<typeof createIndexing>,
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
      };
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
        chainId: 1,
        blockHeight: Number(lastRow.blockHeight),
        blockTime: Number(lastRow.blockTime),
      },
      { db: context.db },
    );

    return Result.ok(undefined);
  }

  return {
    async run(filters: Filter[]): Promise<Result<void, StacksApiError | HandlerExecutionError>> {
      if (filters.length === 0) {
        return Result.ok(undefined);
      }

      const handlers: Record<string, EventHandler | undefined> = {};
      for (const filter of filters) {
        handlers[filter.contractId] = filter.handler;
      }
      const indexing = createIndexing({
        logger: context.logger,
        db: context.db,
        handlers,
      });

      const statesResult = await initializeContractStates(filters, context);
      if (statesResult.isErr()) {
        return Result.err(statesResult.error);
      }
      const states = statesResult.value;

      // Main loop: pick lowest cursor block height, fetch one page
      while (states.some((state) => !state.done)) {
        const activeStates = states.filter(
          (state): state is ContractSyncState & { cursor: string } =>
            !state.done && state.cursor !== null,
        );
        if (activeStates.length === 0) {
          break;
        }

        // Fair scheduling: pick contract with lowest block height
        let [lowestState] = activeStates;
        let lowestHeight = parseCursor(lowestState.cursor).blockHeight;
        for (const state of activeStates.slice(1)) {
          const height = parseCursor(state.cursor).blockHeight;
          if (height < lowestHeight) {
            lowestState = state;
            lowestHeight = height;
          }
        }

        // Fetch one page of events
        // oxlint-disable-next-line no-await-in-loop
        const logsResult = await datasourceStacksApi.getContractLogs(
          context,
          lowestState.contractId,
          lowestState.cursor,
        );
        if (logsResult.isErr()) {
          return Result.err(logsResult.error);
        }

        const { results: events, next_cursor: nextCursor } = logsResult.value;

        // Batch fetch transactions (deduplicated by tx_id) in chunks of 5
        const txIds = [...new Set(events.map((event) => event.tx_id))];
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

        const transactions: TransactionApiResponse[] = [];
        for (const chunk of chunkArray(missingTxIds, BATCH_SIZE)) {
          // oxlint-disable-next-line no-await-in-loop
          const txResults = await Promise.all(
            chunk.map((txId) => datasourceStacksApi.getTransaction(context, txId)),
          );
          for (const txResult of txResults) {
            if (txResult.isErr()) {
              return Result.err(txResult.error);
            }
            transactions.push(txResult.value);
          }
        }

        // Batch fetch blocks (deduplicated by block_hash) in chunks of 5
        const blockHashes = [...new Set(transactions.map((transaction) => transaction.block_hash))];
        // oxlint-disable-next-line no-await-in-loop
        const existingBlockHashes = await syncStore.getExistingBlocks(
          { blockHashes, chainId: 1 },
          { db: context.db },
        );
        const missingBlockHashes = blockHashes.filter(
          (hash) => !existingBlockHashes.includes(hash),
        );
        context.logger.debug({
          service: "historicalRuntime",
          msg: `Blocks: ${blockHashes.length} total, ${missingBlockHashes.length} missing`,
        });

        const blocks: BlockApiResponse[] = [];
        for (const chunk of chunkArray(missingBlockHashes, BATCH_SIZE)) {
          // oxlint-disable-next-line no-await-in-loop
          const blockResults = await Promise.all(
            chunk.map((hash) => datasourceStacksApi.getBlockByHash(context, hash)),
          );
          for (const blockResult of blockResults) {
            if (blockResult.isErr()) {
              return Result.err(blockResult.error);
            }
            blocks.push(blockResult.value);
          }
        }

        // Store blocks, transactions, and events
        // Only smart_contract_log events have a `value` field; skip other event types.
        const smartContractLogs = events.filter(
          (event) => event.event_type === "smart_contract_log",
        );
        const eventsWithBlockHeight = smartContractLogs.map((event) => {
          const tx = transactions.find((transaction) => transaction.tx_id === event.tx_id);
          return { event, blockHeight: tx?.block_height ?? 0 };
        });

        // oxlint-disable-next-line no-await-in-loop
        await context.db.transaction(async (tx) => {
          await Promise.all([
            syncStore.insertBlocks({ blocks }, { db: tx }),
            syncStore.insertTransactions({ transactions }, { db: tx }),
            syncStore.insertEvents({ events: eventsWithBlockHeight }, { db: tx }),
          ]);
        });

        // Update progress or mark done
        if (nextCursor) {
          const lastBlockHeight = parseCursor(nextCursor).blockHeight;
          // oxlint-disable-next-line no-await-in-loop
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
        } else {
          lowestState.done = true;
        }

        // Incremental indexing: process all events up to the safe block height
        const safeHeight = getSafeBlockHeight(states);
        if (safeHeight !== undefined) {
          // oxlint-disable-next-line no-await-in-loop
          const indexResult = await processEventsUpTo(safeHeight, indexing);
          if (indexResult.isErr()) {
            return Result.err(indexResult.error);
          }
        }
      }

      // Final indexing pass: process all remaining events
      // oxlint-disable-next-line no-await-in-loop
      const finalIndexResult = await processEventsUpTo(Number.MAX_SAFE_INTEGER, indexing);
      if (finalIndexResult.isErr()) {
        return Result.err(finalIndexResult.error);
      }

      return Result.ok(undefined);
    },
  };
};
