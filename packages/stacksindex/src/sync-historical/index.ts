import { Result } from "better-result";

import type { StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type PrincipalTransactionsResponse,
  type TransactionApiResponse,
} from "../datasources/api/index.ts";
import { startClock } from "../lib/timer.ts";
import type { Logger } from "../logger/index.ts";

export interface HistoricalSyncContext {
  logger: Logger;
  api?: {
    baseUrl?: string;
    apiKey?: string;
  };
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
  if (parts.length < 3 || parts.length > 4) {
    throw new Error(`Invalid cursor format: ${cursor}`);
  }
  if (parts.length === 3) {
    return {
      blockHeight: Number(parts[0]),
      microblockSequence: 0,
      txIndex: Number(parts[1]),
      eventIndex: Number(parts[2]),
    };
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
  if (!tx.events) {
    return null;
  }
  for (const event of tx.events) {
    if (
      event.event_type === "smart_contract_log" &&
      event.contract_log.contract_id === contractId
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

    const pages: PrincipalTransactionsResponse["results"][] = [];
    let currentCursor: string | null = null;

    do {
      context.logger.debug({
        service: "getContractEventsFirstCursor",
        msg: `Scanning page for ${contractId}`,
        cursor: currentCursor,
      });

      // oxlint-disable-next-line no-await-in-loop
      const pageResult = await datasourceStacksApi.getPrincipalTransactions(context, contractId, {
        limit: ADDRESS_TX_LIMIT,
        cursor: currentCursor,
      });
      if (pageResult.isErr()) {
        return Result.err(pageResult.error);
      }

      const { results, cursor } = pageResult.value;
      if (results.length === 0) {
        break;
      }

      pages.push(results);
      currentCursor = cursor.next;
    } while (currentCursor);

    if (pages.length === 0) {
      const duration = stopClock();
      context.logger.info({
        service: "getContractEventsFirstCursor",
        msg: `No transactions found for ${contractId}`,
        duration,
      });
      return Result.ok(null);
    }

    context.logger.info({
      service: "getContractEventsFirstCursor",
      msg: `Looking for first event of ${contractId} across ${pages.length} page(s)`,
    });

    // Walk backwards through pages (from oldest page to newest page)
    for (const page of pages.slice().reverse()) {
      // Iterate from oldest to newest within the page
      for (const item of page.slice().reverse()) {
        // oxlint-disable-next-line no-await-in-loop
        const txResult = await datasourceStacksApi.getTransaction(context, item.transaction.tx_id);
        if (txResult.isErr()) {
          return Result.err(txResult.error);
        }

        const fullTx = txResult.value;
        const firstEvent = findFirstContractEvent(fullTx, contractId);
        if (firstEvent) {
          const cursor = buildCursor({
            blockHeight: fullTx.block.height,
            microblockSequence: 0,
            txIndex: fullTx.block.tx_index,
            eventIndex: firstEvent.event_index,
          });
          const duration = stopClock();
          context.logger.info({
            service: "getContractEventsFirstCursor",
            msg: `Found first cursor for ${contractId} at block ${fullTx.block.height}`,
            block: fullTx.block.height,
            duration,
          });
          return Result.ok(cursor);
        }
      }
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
