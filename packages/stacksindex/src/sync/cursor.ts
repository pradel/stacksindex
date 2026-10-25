import { Effect, Schema, SchemaGetter } from "effect";

import {
  type PrincipalTransactionsResponse,
  StacksClient,
  type StacksApiError,
  type TransactionEventsResponse,
} from "../datasources/api/index.ts";
import { InvalidCursorError } from "../lib/errors.ts";
import { MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from "../lib/network.ts";

export interface LogsCursor {
  blockHeight: number;
  microblockSequence: number;
  txIndex: number;
  eventIndex: number;
}

export const buildLogsCursor = ({
  blockHeight,
  microblockSequence,
  txIndex,
  eventIndex,
}: LogsCursor): string => `${blockHeight}:${microblockSequence}:${txIndex}:${eventIndex}`;

const LogsCursorSchema = Schema.TemplateLiteralParser([
  Schema.Natural,
  ":",
  Schema.Natural,
  ":",
  Schema.Natural,
  ":",
  Schema.Natural,
]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      blockHeight: Schema.Natural,
      microblockSequence: Schema.Natural,
      txIndex: Schema.Natural,
      eventIndex: Schema.Natural,
    }),
    {
      decode: SchemaGetter.transform((parts) => ({
        blockHeight: parts[0],
        microblockSequence: parts[2],
        txIndex: parts[4],
        eventIndex: parts[6],
      })),
      encode: SchemaGetter.transform((cursor) => [
        cursor.blockHeight,
        ":",
        cursor.microblockSequence,
        ":",
        cursor.txIndex,
        ":",
        cursor.eventIndex,
      ]),
    },
  ),
);

const decodeLogsCursor = Schema.decodeUnknownEffect(LogsCursorSchema);

export const parseLogsCursor = (cursor: string): Effect.Effect<LogsCursor, InvalidCursorError> =>
  decodeLogsCursor(cursor).pipe(
    Effect.mapError(
      (error) => new InvalidCursorError({ format: "logs", cursor, message: error.message }),
    ),
  );

export interface TransactionCursor {
  blockHeight: number;
  microblockSequence: number;
  txIndex: number;
}

export const buildTransactionCursor = ({
  blockHeight,
  microblockSequence,
  txIndex,
}: TransactionCursor): string => `${blockHeight}:${microblockSequence}:${txIndex}`;

const TransactionCursorSchema = Schema.TemplateLiteralParser([
  Schema.Natural,
  ":",
  Schema.Natural,
  ":",
  Schema.Natural,
]).pipe(
  Schema.decodeTo(
    Schema.Struct({
      blockHeight: Schema.Natural,
      microblockSequence: Schema.Natural,
      txIndex: Schema.Natural,
    }),
    {
      decode: SchemaGetter.transform((parts) => ({
        blockHeight: parts[0],
        microblockSequence: parts[2],
        txIndex: parts[4],
      })),
      encode: SchemaGetter.transform((cursor) => [
        cursor.blockHeight,
        ":",
        cursor.microblockSequence,
        ":",
        cursor.txIndex,
      ]),
    },
  ),
);

const decodeTransactionCursor = Schema.decodeUnknownEffect(TransactionCursorSchema);

export const parseTransactionCursor = (
  cursor: string,
): Effect.Effect<TransactionCursor, InvalidCursorError> =>
  decodeTransactionCursor(cursor).pipe(
    Effect.mapError(
      (error) => new InvalidCursorError({ format: "transaction", cursor, message: error.message }),
    ),
  );

function findFirstMatchingContractEvent(
  txId: string,
  contractId: string,
): Effect.Effect<{ event_index: number } | null, StacksApiError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;
    let eventCursor: string | null = "initial";

    while (eventCursor) {
      const eventsResponse: TransactionEventsResponse = yield* client.getTransactionEvents(txId, {
        limit: 50,
        cursor: eventCursor === "initial" ? undefined : eventCursor,
      });

      const { results, cursor } = eventsResponse;

      for (const event of results) {
        if (event.type === "contract_log" && "contract_log" in event) {
          if (event.contract_log.contract_id === contractId) {
            return { event_index: event.event_index };
          }
        }
      }

      eventCursor = cursor.next;
    }

    return null;
  });
}

type PrincipalTransaction = PrincipalTransactionsResponse["results"][number]["transaction"];

/** `microblock_sequence` of every transaction confirmed in an anchor block. */
const ANCHOR_BLOCK_MICROBLOCK_SEQUENCE = 2_147_483_647;

/**
 * Bitcoin height at which epoch 2.5 starts, from each network's `GET /v2/pox`
 * epochs. From then on blocks cannot confirm microblocks, so every transaction
 * has the anchor-block `microblock_sequence`. Devnets share the testnet chain
 * ID, so their early blocks are assumed to confirm no microblocks either.
 */
const EPOCH_2_5_START_HEIGHT = new Map<number, number>([
  [MAINNET_CHAIN_ID, 840_360],
  [TESTNET_CHAIN_ID, 6],
]);

function checkTransactionForMatchingEvent(
  transaction: PrincipalTransaction,
  contractId: string,
  chainId: number,
): Effect.Effect<LogsCursor | null, StacksApiError, StacksClient> {
  return Effect.gen(function* () {
    if (transaction.event_count === 0) {
      return null;
    }

    const matchingEvent = yield* findFirstMatchingContractEvent(transaction.tx_id, contractId);

    if (!matchingEvent) {
      return null;
    }

    // The v2 /logs endpoint strictly matches (block_height, microblock_sequence, tx_index, event_index).
    // Transactions confirmed in an anchor block have microblock_sequence = 2147483647 (0x7FFFFFFF), while
    // Microblock transactions have 0..N. V3 endpoints dropped microblock_sequence, so before epoch 2.5
    // (or on an unknown chain) GET /extended/v1/tx/{tx_id} is the only endpoint that provides it.
    const client = yield* StacksClient;
    const epoch25Height = EPOCH_2_5_START_HEIGHT.get(chainId);

    const microblockSequence =
      epoch25Height !== undefined && transaction.bitcoin_block.height >= epoch25Height
        ? ANCHOR_BLOCK_MICROBLOCK_SEQUENCE
        : (yield* client.getV1Transaction(transaction.tx_id)).microblock_sequence;

    return {
      blockHeight: transaction.block.height,
      microblockSequence,
      txIndex: transaction.block.tx_index,
      eventIndex: matchingEvent.event_index,
    };
  });
}

/**
 * Discovers the initial cursor required to start synchronizing smart contract logs.
 *
 * ### Background & API Limitations
 * 1. **`/extended/v2/smart-contracts/{contract_id}/logs` pages backwards from an existing event**:
 *    - The logs endpoint expects a 4-part cursor formatted as `block_height:microblock_sequence:tx_index:event_index`.
 *    - A cursor selects the events at or below it (newest first), so a synthesized cursor such as
 *      `${deploymentBlock}:0:0:0` returns older events, and older API versions reject it with
 *      `404 Not Found (Cursor not found)`. Paging forward requires the cursor of the first event itself.
 *
 * 2. **`/extended/v3/principals/{principal}/transactions` defaults to reverse-chronological order (newest first)**:
 *    - Default pagination starts from the latest tip and only paginates backwards via `cursor.next`.
 *    - For active contracts with hundreds of thousands of transactions, traversing from the tip backwards would require
 *      thousands of sequential HTTP requests just to reach the contract's genesis.
 *    - However, the transactions endpoint allows inequality coordinate querying (`<= cursor`). Passing a cursor like
 *      `${deploymentBlock}:0:0` jumps directly to that block's transactions without validating prior existence.
 *
 * 3. **Transactions may contain non-log events or logs for other contracts**:
 *    - In v3, transaction summaries return `event_count` rather than an inline `events` array.
 *    - A transaction's events may be token transfers (`ft_asset`, `stx_asset`), locks, or print logs for other contracts
 *      in a multi-contract transaction.
 *    - Blindly using `event_index: 0` can result in a 404 from `/logs` if index 0 is not a `contract_log` for that contract.
 *
 * 4. **`microblock_sequence` resolution**:
 *    - `/logs` strictly validates `microblock_sequence` (`2147483647` for anchor blocks, `0..N` for microblocks).
 *    - V3 transaction endpoints dropped `microblock_sequence`, and v3 pagination cursors do not contain it.
 *    - From epoch 2.5 on, blocks cannot confirm microblocks, so the sequence is always `2147483647`. For older
 *      events, and on chains whose epoch 2.5 height is unknown, `GET /extended/v1/tx/{tx_id}` is the only way to
 *      obtain it.
 *
 * ### Implementation Strategy
 * 1. Fetch contract metadata via `GET /extended/v3/smart-contracts/{contract_id}` (1 request) to obtain its deployment `block.height`.
 * 2. Jump straight to the deployment block by querying `getPrincipalTransactions` with `cursor: "${deploymentBlock}:0:0"`.
 * 3. Iterate the page's transaction summaries from oldest to newest:
 *    - If `event_count === 0`, skip immediately (0 extra requests).
 *    - Otherwise, fetch `GET /extended/v3/transactions/{tx_id}/events` to locate the first `contract_log`
 *      matching `contract_id`.
 *    - When found, take `2147483647` as its `microblock_sequence` if its Bitcoin block is at or after epoch 2.5,
 *      else fetch `GET /extended/v1/tx/{tx_id}` (e.g. `2147483647` for anchor blocks, `0..N` for microblocks),
 *      and construct the exact 4-part cursor (`block.height:microblock_sequence:block.tx_index:event_index`)
 *      for `getContractLogs`.
 * 4. If no transactions on the deployment page have matching logs, traverse forward in time (older -> newer) using `cursor.previous`.
 */
export const getContractEventsFirstCursor = (
  contractId: string,
  options: { chainId: number; startBlock?: number },
): Effect.Effect<string | null, StacksApiError, StacksClient> =>
  Effect.gen(function* getContractEventsFirstCursor() {
    const client = yield* StacksClient;
    const ADDRESS_TX_LIMIT = 50;

    yield* Effect.logDebug(`Looking for deployment of ${contractId}`).pipe(
      Effect.annotateLogs({ contractId, phase: "cursor" }),
    );

    const contract = yield* client.getContract(contractId);
    const deploymentBlockHeight = contract.block.height;

    const initialBlockHeight =
      options.startBlock === undefined
        ? deploymentBlockHeight
        : Math.max(deploymentBlockHeight, options.startBlock);

    yield* Effect.logDebug(
      `Looking for first event of ${contractId} starting at block ${initialBlockHeight}`,
    ).pipe(
      Effect.annotateLogs({
        contractId,
        phase: "cursor",
        deploymentBlockHeight,
        initialBlockHeight,
      }),
    );

    let currentCursor: string | null = buildTransactionCursor({
      blockHeight: initialBlockHeight,
      microblockSequence: 0,
      txIndex: 0,
    });

    while (currentCursor) {
      yield* Effect.logDebug(`Scanning page for ${contractId}`).pipe(
        Effect.annotateLogs({ contractId, phase: "cursor", cursor: currentCursor }),
      );

      const page: PrincipalTransactionsResponse = yield* client.getPrincipalTransactions(
        contractId,
        {
          limit: ADDRESS_TX_LIMIT,
          cursor: currentCursor,
        },
      );

      const { results, cursor } = page;

      if (results.length === 0) {
        break;
      }

      // Iterate from oldest to newest within the page
      for (const item of results.slice().reverse()) {
        const itemBlockHeight = item.transaction.block.height;

        const isBeforeStart =
          options.startBlock !== undefined && itemBlockHeight < options.startBlock;

        if (!isBeforeStart) {
          const cursorResult = yield* checkTransactionForMatchingEvent(
            item.transaction,
            contractId,
            options.chainId,
          );

          if (cursorResult) {
            const firstCursor = buildLogsCursor(cursorResult);

            yield* Effect.logDebug(
              `Found first cursor for ${contractId} at block ${cursorResult.blockHeight}`,
            ).pipe(
              Effect.annotateLogs({
                contractId,
                phase: "cursor",
                block: cursorResult.blockHeight,
              }),
            );

            return firstCursor;
          }
        }
      }

      // Move forward in time to newer transactions
      currentCursor = cursor.previous;
    }

    yield* Effect.logDebug(`No events found for ${contractId}`).pipe(
      Effect.annotateLogs({ contractId, phase: "cursor" }),
    );

    return null;
  }).pipe(
    Effect.annotateLogs({ service: "getContractEventsFirstCursor" }),
    Effect.withLogSpan("getContractEventsFirstCursor"),
  );
