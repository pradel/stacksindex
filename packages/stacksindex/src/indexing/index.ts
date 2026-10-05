import { Cause, Effect } from "effect";

import { decodeClarityWithSchema } from "../codec/index.ts";
import { IndexerDatabase, toThenable } from "../database/index.ts";
import { readOnly, StacksClient } from "../datasources/api/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import type { HandlerContext, HandlerEvent, Handlers, IndexingClient } from "../lib/types.ts";

export interface IndexingContext {
  handlers: Handlers;
}

export const createIndexing = (context: IndexingContext) => ({
  executeEvent(
    event: HandlerEvent,
  ): Effect.Effect<void, HandlerExecutionError, StacksClient | IndexerDatabase> {
    const handler = context.handlers[event.contract_log.contract_id];

    if (handler === undefined) {
      return Effect.logDebug("No handler found for event").pipe(
        Effect.annotateLogs({
          contractId: event.contract_log.contract_id,
          eventType: event.event_type,
          blockHeight: event.block_height,
          txIndex: event.tx_index,
        }),
      );
    }

    return IndexerDatabase.transaction((tx) =>
      Effect.gen(function* executeEvent() {
        const stacksClient = yield* StacksClient;

        // SAFETY: The runtime dispatch below mirrors both overloads: an `abi` field selects the typed read path.
        const client: IndexingClient = {
          // oxlint-disable-next-line typescript/no-explicit-any
          callReadOnly: ((options: any) => {
            if ("abi" in options) {
              return toThenable(
                readOnly(stacksClient.callReadFunction, {
                  ...options,
                  tip: options.tip ?? event.block_height,
                }),
              );
            }

            const contractId = `${options.contractAddress}.${options.contractName}`;

            return toThenable(
              stacksClient.callReadFunction(contractId, options.functionName, {
                args: options.args,
                sender: options.senderAddress,
                tip: options.tip ?? event.block_height,
              }),
            );
          }) as IndexingClient["callReadOnly"],
        };

        // SAFETY: Schemas decoded here are pure, so the decode effect has no remaining requirements and its error channel widens to `unknown`.
        const handlerContext: HandlerContext = {
          db: tx,
          client,
          decode: (schema, hex) =>
            decodeClarityWithSchema(schema)(hex) as Effect.Effect<(typeof schema)["Type"], unknown>,
        };

        let result: Effect.Effect<void, any> | Promise<void>;

        try {
          result = handler(event, handlerContext);
        } catch (err) {
          return yield* Effect.fail(err);
        }

        if (Effect.isEffect(result)) {
          yield* result;
        } else {
          yield* Effect.tryPromise({
            try: () => Promise.resolve(result),
            catch: (err) => err,
          });
        }
      }),
    ).pipe(
      Effect.asVoid,
      Effect.tap(() =>
        Effect.logDebug("Executed event handler").pipe(
          Effect.annotateLogs({
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
  },
});
