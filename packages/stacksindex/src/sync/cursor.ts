import { Effect, Predicate, Schema, SchemaGetter } from "effect";
import { HttpClientError } from "effect/http";

import {
  type ContractLogsResponse,
  StacksClient,
  type StacksApiError,
  type StacksHttpError,
} from "../datasources/api/index.ts";
import { InvalidCursorError } from "../lib/errors.ts";

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

/** `microblock_sequence` of events confirmed in an anchor block (the highest value). */
const ANCHOR_MICROBLOCK_SEQUENCE = 2_147_483_647;

/** Highest `tx_index` the logs endpoint accepts (a Postgres `smallint`). */
const MAX_TX_INDEX = 32_767;

/** Highest `event_index` the logs endpoint accepts (a Postgres `integer`). */
const MAX_EVENT_INDEX = 2_147_483_647;

/** A logs cursor selecting every event at or below `blockHeight`. */
const atOrBelowBlock = (blockHeight: number): string =>
  buildLogsCursor({
    blockHeight,
    microblockSequence: ANCHOR_MICROBLOCK_SEQUENCE,
    txIndex: MAX_TX_INDEX,
    eventIndex: MAX_EVENT_INDEX,
  });

/**
 * The newest page of events at or below `cursor`, or `undefined` when the
 * contract has none: the logs endpoint answers `404 Cursor not found`.
 */
function fetchLogsAtOrBelow(
  contractId: string,
  cursor: string,
  limit?: number,
): Effect.Effect<ContractLogsResponse | undefined, StacksHttpError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;

    return yield* client.getContractLogs(contractId, { cursor, limit });
  }).pipe(
    Effect.catchIf(
      (error) =>
        HttpClientError.isHttpClientError(error) &&
        Predicate.isTagged(error.reason, "StatusCodeError") &&
        error.reason.response.status === 404,
      () => Effect.succeed(undefined),
    ),
  );
}

/** Whether the contract has an event at or below `blockHeight`, read with a one-event page. */
function hasEventAtOrBelow(
  contractId: string,
  blockHeight: number,
): Effect.Effect<boolean, StacksHttpError, StacksClient> {
  return fetchLogsAtOrBelow(contractId, atOrBelowBlock(blockHeight), 1).pipe(
    Effect.map((page) => page !== undefined),
  );
}

/**
 * Finds the logs cursor to start forward pagination from so that every event
 * of the contract at or above `fromBlockHeight` is fetched, or `null` when
 * fewer than one page of such events exists and the newest page covers them.
 *
 * The logs endpoint pages newest first, and a cursor selects the events at or
 * below it. A synthesized cursor (`height:2147483647:32767:2147483647`) need
 * not match an existing event, so:
 *
 * - With events below `fromBlockHeight`, the page at or below
 *   `fromBlockHeight - 1` ends at the newest of them, and its `next_cursor`
 *   (one full page newer) starts at the first event at or above
 *   `fromBlockHeight`. One request.
 * - Without them, a binary search over block heights (one-event pages) finds
 *   the first block holding events, then `prev_cursor` walks to that block's
 *   oldest page.
 *
 * Only the contract's own logs are read, so events emitted through calls made
 * by other contracts are found too.
 */
export const findBackfillCursor = (
  contractId: string,
  fromBlockHeight: number,
): Effect.Effect<string | null, StacksApiError | InvalidCursorError, StacksClient> =>
  Effect.gen(function* () {
    const client = yield* StacksClient;

    if (fromBlockHeight > 0) {
      const below = yield* fetchLogsAtOrBelow(contractId, atOrBelowBlock(fromBlockHeight - 1));

      if (below !== undefined) {
        return below.next_cursor;
      }
    }

    const head = yield* client.getContractLogs(contractId, { limit: 1 });

    if (head.results.length === 0 || !head.cursor) {
      return null;
    }

    let high = (yield* parseLogsCursor(head.cursor)).blockHeight;

    if (!(yield* hasEventAtOrBelow(contractId, high))) {
      return yield* new InvalidCursorError({
        format: "logs",
        cursor: atOrBelowBlock(high),
        message:
          "The Stacks API rejected a logs cursor that does not match an event; this stacks-blockchain-api version is not supported",
      });
    }

    let low = fromBlockHeight;

    while (low < high) {
      const middle = Math.floor((low + high) / 2);

      if (yield* hasEventAtOrBelow(contractId, middle)) {
        high = middle;
      } else {
        low = middle + 1;
      }
    }

    // The events of the first block holding any, newest first.
    let page = yield* client.getContractLogs(contractId, { cursor: atOrBelowBlock(high) });

    while (page.prev_cursor) {
      page = yield* client.getContractLogs(contractId, { cursor: page.prev_cursor });
    }

    return page.cursor;
  }).pipe(Effect.annotateLogs({ contractId, phase: "cursor" }));
