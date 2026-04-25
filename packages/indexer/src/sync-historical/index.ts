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
  return {
    blockHeight: Number(parts[0]),
    microblockSequence: Number(parts[1]),
    txIndex: Number(parts[2]),
    eventIndex: Number(parts[3]),
  };
};

function findFirstContractEvent(
  tx: TransactionApiResponse,
  contractId: string,
): { event_index: number } | null {
  for (const event of tx.events) {
    if (
      event.event_type === "smart_contract_log" &&
      event.contract_log?.contract_id === contractId
    ) {
      return { event_index: event.event_index };
    }
  }
  return null;
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

    // Walk backwards through pages so we process oldest transactions first.
    let offset = Math.max(0, total - ADDRESS_TX_LIMIT);

    while (offset >= 0) {
      // oxlint-disable-next-line no-await-in-loop
      const pageResult = await datasourceStacksApi.getAddressTransactions(context, contractId, {
        limit: ADDRESS_TX_LIMIT,
        offset,
      });
      if (pageResult.isErr()) {
        return Result.err(pageResult.error);
      }

      const txs = pageResult.value.results;
      // Iterate from oldest to newest within the page.
      for (const tx of txs.slice().reverse()) {
        // Skip transactions with no events.
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
            context.logger.debug({
              service: "getContractEventsFirstCursor",
              msg: `First cursor found ${cursor}`,
              duration,
            });
            return Result.ok(cursor);
          }
        }
      }

      if (offset === 0) {
        break;
      }
      offset = Math.max(0, offset - ADDRESS_TX_LIMIT);
    }

    const duration = stopClock();
    context.logger.debug({
      service: "getContractEventsFirstCursor",
      msg: `No cursor found for ${contractId}`,
      duration,
    });
    return Result.ok(null);
  },
});
