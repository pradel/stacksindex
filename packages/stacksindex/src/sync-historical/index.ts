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
   * 3. **`/extended/v3/transactions/{tx_id}` returns `event_count` instead of an inline events array**:
   *    - In the v3 API, transaction objects provide an `event_count` number indicating how many events were produced.
   *
   * ### Implementation Strategy
   * 1. Fetch contract metadata via `GET /extended/v1/contract/{contract_id}` (1 request) to obtain its deployment `block_height`.
   * 2. Jump straight to the deployment block by querying `getPrincipalTransactions` with `cursor: "${deploymentBlock}:0:0"`.
   * 3. Iterate transactions from oldest to newest within the page and inspect `event_count`.
   * 4. When a transaction with `event_count > 0` is found, construct the initial cursor (`block.height:0:block.tx_index:0`) for `getContractLogs`.
   * 5. If no transactions on the deployment page have events, traverse forward in time (older -> newer) using `cursor.previous`.
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
          const firstCursor = buildCursor({
            blockHeight: fullTx.block.height,
            microblockSequence: 0,
            txIndex: fullTx.block.tx_index,
            eventIndex: 0,
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
