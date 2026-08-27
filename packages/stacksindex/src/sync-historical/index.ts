import { Result } from "better-result";

import type { StacksApiError } from "../datasources/api/errors.ts";
import { datasourceStacksApi } from "../datasources/api/index.ts";
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

async function findFirstMatchingContractEvent(
  context: HistoricalSyncContext,
  txId: string,
  contractId: string,
): Promise<Result<{ event_index: number } | null, StacksApiError>> {
  let eventCursor: string | null = "initial";
  while (eventCursor) {
    // oxlint-disable-next-line no-await-in-loop
    const eventsResult = await datasourceStacksApi.getTransactionEvents(context, txId, {
      limit: 50,
      cursor: eventCursor === "initial" ? undefined : eventCursor,
    });
    if (eventsResult.isErr()) {
      return Result.err(eventsResult.error);
    }
    const { results, cursor } = eventsResult.value;
    for (const event of results) {
      if (event.type === "contract_log" && "contract_log" in event) {
        if (event.contract_log.contract_id === contractId) {
          return Result.ok({ event_index: event.event_index });
        }
      }
    }
    eventCursor = cursor.next;
  }
  return Result.ok(null);
}

export const createHistoricalSync = (context: HistoricalSyncContext) => ({
  /**
   * Discovers the initial cursor required to start synchronizing smart contract logs.
   *
   * ### Background & API Limitations
   * 1. **`/extended/v2/smart-contracts/{contract_id}/logs` requires an existing on-chain cursor**:
   *    - The logs endpoint expects a 4-part cursor formatted as `block_height:microblock_sequence:tx_index:event_index`.
   *    - The API strictly validates that this cursor matches an actual existing event on-chain; passing arbitrary or
   *      synthesized cursors (such as `0:0:0:0` or `${deploymentBlock}:0:0:0`) returns `404 Not Found (Cursor not found)`.
   *
   * 2. **`/extended/v3/principals/{principal}/transactions` defaults to reverse-chronological order (newest first)**:
   *    - Default pagination starts from the latest tip and only paginates backwards via `cursor.next`.
   *    - For active contracts with hundreds of thousands of transactions, traversing from the tip backwards would require
   *      thousands of sequential HTTP requests just to reach the contract's genesis.
   *    - However, the transactions endpoint allows inequality coordinate querying (`<= cursor`). Passing a cursor like
   *      `${deploymentBlock}:0:0` jumps directly to that block's transactions without validating prior existence.
   *
   * 3. **Transactions may contain non-log events or logs for other contracts**:
   *    - In v3, transaction objects return `event_count` rather than an inline `events` array.
   *    - A transaction's events may be token transfers (`ft_asset`, `stx_asset`), locks, or print logs for other contracts
   *      in a multi-contract transaction.
   *    - Blindly using `event_index: 0` can result in a 404 from `/logs` if index 0 is not a `contract_log` for that contract.
   *
   * ### Implementation Strategy
   * 1. Fetch contract metadata via `GET /extended/v1/contract/{contract_id}` (1 request) to obtain its deployment `block_height`.
   * 2. Jump straight to the deployment block by querying `getPrincipalTransactions` with `cursor: "${deploymentBlock}:0:0"`.
   * 3. Iterate transactions from oldest to newest within the page:
   *    - If `event_count === 0`, skip immediately (0 extra requests).
   *    - If `event_count > 0`, fetch `GET /extended/v3/transactions/{tx_id}/events` to locate the first `contract_log`
   *      matching `contract_id`.
   * 4. When found, construct the exact 4-part cursor (`block.height:0:block.tx_index:event_index`) for `getContractLogs`.
   * 5. If no transactions on the deployment page have matching logs, traverse forward in time (older -> newer) using `cursor.previous`.
   */
  async getContractEventsFirstCursor(
    contractId: string,
  ): Promise<Result<string | null, StacksApiError>> {
    const stopClock = startClock();
    const ADDRESS_TX_LIMIT = 50;

    context.logger.info({
      service: "getContractEventsFirstCursor",
      msg: `Looking for deployment of ${contractId}`,
    });

    const contractResult = await datasourceStacksApi.getContract(context, contractId);
    if (contractResult.isErr()) {
      return Result.err(contractResult.error);
    }

    const { block_height: deploymentBlockHeight } = contractResult.value;

    context.logger.info({
      service: "getContractEventsFirstCursor",
      msg: `Looking for first event of ${contractId} starting at block ${deploymentBlockHeight}`,
      deploymentBlockHeight,
    });

    let currentCursor: string | null = `${deploymentBlockHeight}:0:0`;

    while (currentCursor) {
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

      // Iterate from oldest to newest within the page
      for (const item of results.slice().reverse()) {
        // oxlint-disable-next-line no-await-in-loop
        const txResult = await datasourceStacksApi.getTransaction(context, item.transaction.tx_id);
        if (txResult.isErr()) {
          return Result.err(txResult.error);
        }

        const fullTx = txResult.value;
        if (fullTx.event_count > 0) {
          // oxlint-disable-next-line no-await-in-loop
          const matchingEventResult = await findFirstMatchingContractEvent(
            context,
            fullTx.tx_id,
            contractId,
          );
          if (matchingEventResult.isErr()) {
            return Result.err(matchingEventResult.error);
          }

          const matchingEvent = matchingEventResult.value;
          if (matchingEvent) {
            const firstCursor = buildCursor({
              blockHeight: fullTx.block.height,
              microblockSequence: 0,
              txIndex: fullTx.block.tx_index,
              eventIndex: matchingEvent.event_index,
            });
            const duration = stopClock();
            context.logger.info({
              service: "getContractEventsFirstCursor",
              msg: `Found first cursor for ${contractId} at block ${fullTx.block.height}`,
              block: fullTx.block.height,
              duration,
            });
            return Result.ok(firstCursor);
          }
        }
      }

      // Move forward in time to newer transactions
      currentCursor = cursor.previous;
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
