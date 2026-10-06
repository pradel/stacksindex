import { Cause, Context, Effect, Layer } from "effect";

import { decodeClarityWithSchema } from "../codec/index.ts";
import { type IndexerDb, IndexerDatabase } from "../database/index.ts";
import { readOnly, StacksClient, type StacksClientService } from "../datasources/api/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import type { HandlerContext, HandlerEvent, Handlers, IndexingClient } from "../lib/types.ts";

export interface IndexingService {
  /**
   * Executes the handler for every event in `events` using the ambient
   * `IndexerDatabase`. The caller owns the transaction, so a batch of handler
   * writes and its checkpoint can be committed atomically.
   *
   * Returns the number of events passed to handlers.
   */
  readonly executeBatch: (
    events: readonly HandlerEvent[],
  ) => Effect.Effect<number, HandlerExecutionError, IndexerDatabase>;
}

export interface IndexingOptions {
  handlers: Handlers;
  client: StacksClientService;
}

export const createIndexing = ({
  handlers,
  client: stacksClient,
}: IndexingOptions): IndexingService => {
  const executeEvent = (
    event: HandlerEvent,
    db: IndexerDb,
  ): Effect.Effect<void, HandlerExecutionError> => {
    const handler = handlers[event.contract_log.contract_id];

    if (handler === undefined) {
      return Effect.logDebug("No handler found for event").pipe(
        Effect.annotateLogs({
          phase: "index",
          contractId: event.contract_log.contract_id,
          eventType: event.event_type,
          blockHeight: event.block_height,
          txIndex: event.tx_index,
        }),
        Effect.asVoid,
      );
    }

    return Effect.gen(function* executeEvent() {
      // SAFETY: `readOnly` runtime-dispatches on the presence of `abi`, mirroring both overloads, and pins the call to the event height unless overridden.
      const client: IndexingClient = {
        // oxlint-disable-next-line typescript/no-explicit-any
        callReadOnly: ((options: any) =>
          readOnly(stacksClient.callReadFunction, {
            ...options,
            tip: options.tip ?? event.block_height,
          })) as IndexingClient["callReadOnly"],
      };

      // SAFETY: Schemas decoded here are pure, so the decode effect has no remaining requirements and its error channel widens to `unknown`.
      const handlerContext: HandlerContext = {
        db,
        client,
        decode: (schema, hex) =>
          decodeClarityWithSchema(schema)(hex) as Effect.Effect<(typeof schema)["Type"], unknown>,
      };

      const result = yield* Effect.try({
        try: () => handler(event, handlerContext),
        catch: (err) => err,
      });

      yield* result;
    }).pipe(
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("Executed event handler").pipe(
          Effect.annotateLogs({
            phase: "index",
            contractId: event.contract_log.contract_id,
            eventType: event.event_type,
            blockHeight: event.block_height,
            txIndex: event.tx_index,
          }),
        ),
      ),
      Effect.withLogSpan("executeEvent"),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          // SAFETY: An interrupt-only cause contains no typed failures, so re-raising it preserves interruption semantics.
          return Effect.failCause(cause as Cause.Cause<never>);
        }

        const err = Cause.squash(cause);

        return Effect.gen(function* () {
          yield* Effect.logError(cause).pipe(
            Effect.annotateLogs({
              phase: "index",
              contractId: event.contract_log.contract_id,
              eventType: event.event_type,
              blockHeight: event.block_height,
              txId: event.tx_id,
              txIndex: event.tx_index,
            }),
          );

          return yield* Effect.fail(
            new HandlerExecutionError({
              contractId: event.contract_log.contract_id,
              cause: err,
            }),
          );
        });
      }),
    );
  };

  return {
    executeBatch(events) {
      return Effect.gen(function* () {
        const db = yield* IndexerDatabase;

        for (const event of events) {
          yield* executeEvent(event, db);
        }

        return events.length;
      });
    },
  };
};

export class Indexing extends Context.Service<Indexing, IndexingService>()(
  "stacksindex/indexing/Indexing",
) {
  static readonly layer = (options: {
    handlers: Handlers;
  }): Layer.Layer<Indexing, never, StacksClient> =>
    Layer.effect(
      Indexing,
      Effect.gen(function* () {
        const client = yield* StacksClient;

        return Indexing.of(createIndexing({ handlers: options.handlers, client }));
      }),
    );
}
