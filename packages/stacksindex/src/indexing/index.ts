import { Cause, Effect } from "effect";

import { decodeClarityWithSchema } from "../codec/index.ts";
import { toThenable, type IndexerDb } from "../database/index.ts";
import { datasourceStacksApi, type DatasourceStacksApiContext } from "../datasources/api/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import { startClock } from "../lib/timer.ts";
import type { HandlerContext, HandlerEvent, Handlers, IndexingClient } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";

export interface IndexingContext {
  logger: Logger;
  db: IndexerDb;
  handlers: Handlers;
  api?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export const createIndexing = (context: IndexingContext) => ({
  executeEvent(event: HandlerEvent): Effect.Effect<void, HandlerExecutionError> {
    const endClock = startClock();
    const handler = context.handlers[event.contract_log.contract_id];

    if (handler === undefined) {
      const duration = endClock();
      context.logger.debug({
        msg: "No handler found for event",
        contractId: event.contract_log.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
        txIndex: event.tx_index,
        duration,
      });
      return Effect.void;
    }

    const handlerClock = startClock();
    return (
      context.db.transaction((tx) =>
        Effect.gen(function* executeEvent() {
          const client: IndexingClient = {
            // oxlint-disable-next-line typescript/no-explicit-any
            callReadOnly: ((options: any) => {
              const apiContext: DatasourceStacksApiContext = {
                logger: context.logger,
                api: context.api,
              };

              if ("abi" in options) {
                return toThenable(
                  datasourceStacksApi.typedCallReadFunction(apiContext, {
                    ...options,
                    tip: options.tip ?? event.block_height,
                  }),
                );
              }

              const contractId = `${options.contractAddress}.${options.contractName}`;
              return toThenable(
                datasourceStacksApi.callReadFunction(apiContext, contractId, options.functionName, {
                  args: options.args,
                  sender: options.senderAddress,
                  tip: options.tip ?? event.block_height,
                }),
              );
            }) as IndexingClient["callReadOnly"],
          };

          const handlerContext: HandlerContext = {
            db: tx,
            client,
            decode: (schema, hex) =>
              decodeClarityWithSchema(schema)(hex) as Effect.Effect<any, unknown>,
          };

          let result: unknown;
          try {
            result = handler(event, handlerContext);
          } catch (err) {
            return yield* Effect.fail(err);
          }
          if (Effect.isEffect(result)) {
            yield* result;
          } else if (result && typeof (result as any).then === "function") {
            yield* Effect.tryPromise({
              try: () => result as Promise<unknown>,
              catch: (err) => err,
            });
          }
        }),
      ) as Effect.Effect<void, unknown>
    ).pipe(
      Effect.asVoid,
      Effect.tap(() =>
        Effect.sync(() => {
          const duration = handlerClock();
          context.logger.debug({
            msg: "Executed event handler",
            contractId: event.contract_log.contract_id,
            eventType: event.event_type,
            blockHeight: event.block_height,
            txIndex: event.tx_index,
            duration,
          });
        }),
      ),
      Effect.catchCause((cause) => {
        const err = Cause.squash(cause);
        const duration = handlerClock();
        context.logger.error({
          msg: "Error executing event handler",
          contractId: event.contract_log.contract_id,
          eventType: event.event_type,
          blockHeight: event.block_height,
          txId: event.tx_id,
          txIndex: event.tx_index,
          duration,
          error: err,
        });
        return Effect.fail(
          new HandlerExecutionError({
            contractId: event.contract_log.contract_id,
            cause: err,
          }),
        );
      }),
    );
  },
});
