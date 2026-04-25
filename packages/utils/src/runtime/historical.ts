import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import type { StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type BlockApiResponse,
  type TransactionApiResponse,
} from "../datasources/api/index.ts";
import type { Logger } from "../logger/index.ts";
import { createHistoricalSync, parseCursor } from "../sync-historical/index.ts";
import { syncStore } from "../sync-store/index.ts";

const BATCH_SIZE = 5;

function chunkArray<Item>(array: Item[], size: number): Item[][] {
  const chunks: Item[][] = [];
  for (let index = 0; index < array.length; index += size) {
    chunks.push(array.slice(index, index + size));
  }
  return chunks;
}

export interface Filter {
  contractId: string;
}

export interface HistoricalRuntimeContext {
  logger: Logger;
  db: NodePgDatabase;
}

interface ContractSyncState {
  contractId: string;
  cursor: string | null;
  done: boolean;
}

export const createHistoricalRuntime = (context: HistoricalRuntimeContext) => ({
  async run(filters: Filter[]): Promise<Result<void, StacksApiError>> {
    if (filters.length === 0) {
      return Result.ok(undefined);
    }

    // Initialize per-contract state
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
          states.push({
            contractId: filter.contractId,
            cursor,
            done: false,
          });
        } else {
          context.logger.debug({
            service: "historicalRuntime",
            msg: `No events found for ${filter.contractId}`,
          });
          states.push({
            contractId: filter.contractId,
            cursor: null,
            done: true,
          });
        }
      } else {
        context.logger.debug({
          service: "historicalRuntime",
          msg: `Resuming sync for ${filter.contractId} from cursor ${saved.cursor}`,
        });
        states.push({
          contractId: filter.contractId,
          cursor: saved.cursor,
          done: false,
        });
      }
    }

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
      const transactions: TransactionApiResponse[] = [];
      for (const chunk of chunkArray(txIds, BATCH_SIZE)) {
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
      const blocks: BlockApiResponse[] = [];
      for (const chunk of chunkArray(blockHashes, BATCH_SIZE)) {
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

      // Store blocks and transactions
      // oxlint-disable-next-line no-await-in-loop
      await Promise.all([
        syncStore.insertBlocks({ blocks }, { db: context.db }),
        syncStore.insertTransactions({ transactions }, { db: context.db }),
      ]);

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
    }

    return Result.ok(undefined);
  },
});
