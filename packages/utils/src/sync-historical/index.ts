import { Result } from "better-result";

import type { StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type ContractLog,
  type TransactionApiResponse,
} from "../datasources/api/index.ts";
import type { Logger } from "../logger/index.ts";

interface HistoricalSyncContext {
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
    const ADDRESS_TX_LIMIT = 50;
    const countResult = await datasourceStacksApi.getAddressTransactions(context, contractId, 1, 0);
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
      const pageResult = await datasourceStacksApi.getAddressTransactions(
        context,
        contractId,
        ADDRESS_TX_LIMIT,
        offset,
      );
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
            return Result.ok(
              buildCursor({
                blockHeight: txResult.value.block_height,
                microblockSequence: txResult.value.microblock_sequence,
                txIndex: txResult.value.tx_index,
                eventIndex: firstEvent.event_index,
              }),
            );
          }
        }
      }

      if (offset === 0) {
        break;
      }
      offset = Math.max(0, offset - ADDRESS_TX_LIMIT);
    }

    return Result.ok(null);
  },

  async run(contractId: string): Promise<Result<void, StacksApiError>> {
    const cursorResult = await this.getContractEventsFirstCursor(contractId);
    if (cursorResult.isErr()) {
      return Result.err(cursorResult.error);
    }
    let cursor = cursorResult.value;
    if (!cursor) {
      return Result.ok(undefined);
    }

    let eventsPage = await datasourceStacksApi.getContractLogs(context, contractId, cursor);
    if (eventsPage.isErr()) {
      return Result.err(eventsPage.error);
    }
    let nextCursor = eventsPage.value.next_cursor;
    let events: ContractLog[] = eventsPage.value.results;

    while (nextCursor) {
      // oxlint-disable-next-line no-await-in-loop
      eventsPage = await datasourceStacksApi.getContractLogs(context, contractId, nextCursor);
      if (eventsPage.isErr()) {
        return Result.err(eventsPage.error);
      }
      events = events.concat(eventsPage.value.results);
      // oxlint-disable-next-line no-useless-assignment
      cursor = nextCursor;
      nextCursor = eventsPage.value.next_cursor;
    }

    return Result.ok(undefined);
  },
});
