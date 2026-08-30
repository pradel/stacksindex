import { Result } from "better-result";

import type { StacksApiError } from "../datasources/api/errors.ts";
import { datasourceStacksApi, type TransactionApiResponse } from "../datasources/api/index.ts";
import { startClock } from "../lib/timer.ts";
import type { Logger } from "../logger/index.ts";

export interface HistoricalSyncContext {
  logger: Logger;
}

interface BuildCursorParams {
  blockHeight: number;
  microblockSequence: number;
  txIndex: number;
  eventIndex: number;
}

export const buildCursor = ({
  blockHeight,
  microblockSequence,
  txIndex,
  eventIndex,
}: BuildCursorParams): string => `${blockHeight}:${microblockSequence}:${txIndex}:${eventIndex}`;

export const parseCursor = (cursor: string): BuildCursorParams => {
  const parts = cursor.split(":");
  if (parts.length !== 4) {
    throw new Error(`Invalid cursor format: ${cursor}`);
  }
  const [blockHeight, microblockSequence, txIndex, eventIndex] = parts.map(Number);
  if (
    !Number.isInteger(blockHeight) ||
    !Number.isInteger(microblockSequence) ||
    !Number.isInteger(txIndex) ||
    !Number.isInteger(eventIndex)
  ) {
    throw new Error(`Invalid cursor format: ${cursor}`);
  }
  return {
    blockHeight,
    microblockSequence,
    txIndex,
    eventIndex,
  };
};

function findFirstContractEvent(
  tx: TransactionApiResponse,
  contractId: string,
): { event_index: number } | null {
  let firstEventIndex: number | null = null;
  for (const event of tx.events) {
    if (
      event.event_type === "smart_contract_log" &&
      event.contract_log.contract_id === contractId
    ) {
      if (firstEventIndex === null || event.event_index < firstEventIndex) {
        firstEventIndex = event.event_index;
      }
    }
  }
  return firstEventIndex === null ? null : { event_index: firstEventIndex };
}

export const createHistoricalSync = (context: HistoricalSyncContext) => ({
  async getContractEventsFirstCursor(
    contractId: string,
  ): Promise<Result<string | null, StacksApiError>> {
    const stopClock = startClock();
    const ADDRESS_TX_LIMIT = 50;
    const countResult = await datasourceStacksApi.getAddressTransactions(context, contractId, {
      limit: 1,
      offset: 0,
    });
    if (countResult.isErr()) {
      return Result.err(countResult.error);
    }

    const { total } = countResult.value;
    if (total === 0) {
      return Result.ok(null);
    }

    context.logger.info({
      service: "getContractEventsFirstCursor",
      msg: `Looking for first event of ${contractId}`,
      totalTransactions: total,
    });

    // Walk backwards through pages so we process oldest transactions first.
    // Limit each request to the remaining count so pages never overlap.
    let remaining = total;

    while (remaining > 0) {
      const limit = Math.min(ADDRESS_TX_LIMIT, remaining);
      const offset = remaining - limit;

      context.logger.debug({
        service: "getContractEventsFirstCursor",
        msg: `Scanning page for ${contractId}`,
        offset,
      });
      // oxlint-disable-next-line no-await-in-loop
      const pageResult = await datasourceStacksApi.getAddressTransactions(context, contractId, {
        limit,
        offset,
        exclude_function_args: true,
      });
      if (pageResult.isErr()) {
        return Result.err(pageResult.error);
      }

      const txs = pageResult.value.results;
      // Iterate from oldest to newest within the page.
      for (const tx of txs.slice().reverse()) {
        if (tx.event_count > 0) {
          // oxlint-disable-next-line no-await-in-loop
          const txResult = await datasourceStacksApi.getTransaction(context, tx.tx_id);
          if (txResult.isErr()) {
            return Result.err(txResult.error);
          }

          const firstEvent = findFirstContractEvent(txResult.value, contractId);
          if (firstEvent) {
            const cursor = buildCursor({
              blockHeight: txResult.value.block_height,
              microblockSequence: txResult.value.microblock_sequence,
              txIndex: txResult.value.tx_index,
              eventIndex: firstEvent.event_index,
            });
            const duration = stopClock();
            context.logger.info({
              service: "getContractEventsFirstCursor",
              msg: `Found first cursor for ${contractId} at block ${txResult.value.block_height}`,
              block: txResult.value.block_height,
              duration,
            });
            return Result.ok(cursor);
          }
        }
      }

      remaining = offset;
    }

    const duration = stopClock();
    context.logger.info({
      service: "getContractEventsFirstCursor",
      msg: `No events found for ${contractId}`,
      duration,
    });
    return Result.ok(null);
  },
});
