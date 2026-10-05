import { Cause, Effect } from "effect";
import { HttpClient } from "effect/http";

import { decodeClarityWithSchema } from "../codec/index.ts";
import { toThenable, type IndexerDb } from "../database/index.ts";
import { datasourceStacksApi, type DatasourceStacksApiContext } from "../datasources/api/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import { startClock } from "../lib/timer.ts";
import type { HandlerContext, HandlerEvent, Handlers, IndexingClient } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    (typeof value === "object" || typeof value === "function") &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export interface IndexingContext {
  logger: Logger;
  db: IndexerDb;
  handlers: Handlers;
  httpClient: HttpClient.HttpClient;
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

    // SAFETY: Drizzle's Effect transaction forwards the generator's success and error channels, which is the contract this assertion needs.
    return (
      context.db.transaction((tx) =>
        Effect.gen(function* executeEvent() {
          const provideClient = <A, E>(
            effect: Effect.Effect<A, E, HttpClient.HttpClient>,
          ): Effect.Effect<A, E> =>
            Effect.provideService(effect, HttpClient.HttpClient, context.httpClient);

          // SAFETY: The runtime dispatch below mirrors both overloads: an `abi` field selects the typed read path.
          const client: IndexingClient = {
            // oxlint-disable-next-line typescript/no-explicit-any
            callReadOnly: ((options: any) => {
              const apiContext: DatasourceStacksApiContext = {
                logger: context.logger,
                api: context.api,
              };

              if ("abi" in options) {
                return toThenable(
                  provideClient(
                    datasourceStacksApi.typedCallReadFunction(apiContext, {
                      ...options,
                      tip: options.tip ?? event.block_height,
                    }),
                  ),
                );
              }

              const contractId = `${options.contractAddress}.${options.contractName}`;

              return toThenable(
                provideClient(
                  datasourceStacksApi.callReadFunction(
                    apiContext,
                    contractId,
                    options.functionName,
                    {
                      args: options.args,
                      sender: options.senderAddress,
                      tip: options.tip ?? event.block_height,
                    },
                  ),
                ),
              );
            }) as IndexingClient["callReadOnly"],
          };

          // SAFETY: Schemas decoded here are pure, so the decode effect has no remaining requirements and its error channel widens to `unknown`.
          const handlerContext: HandlerContext = {
            db: tx,
            client,
            decode: (schema, hex) =>
              decodeClarityWithSchema(schema)(hex) as Effect.Effect<
                (typeof schema)["Type"],
                unknown
              >,
          };

          let result: unknown;

          try {
            result = handler(event, handlerContext);
          } catch (err) {
            return yield* Effect.fail(err);
          }

          if (Effect.isEffect(result)) {
            yield* result;
          } else if (isThenable(result)) {
            yield* Effect.tryPromise({
              try: () => Promise.resolve(result),
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
        if (Cause.hasInterruptsOnly(cause)) {
          // SAFETY: An interrupt-only cause contains no typed failures, so re-raising it preserves interruption semantics.
          return Effect.failCause(cause as Cause.Cause<never>);
        }

        const err = Cause.squash(cause);
        const error = err instanceof Error ? err : new Error(String(err));
        const duration = handlerClock();

        context.logger.error({
          msg: "Error executing event handler",
          contractId: event.contract_log.contract_id,
          eventType: event.event_type,
          blockHeight: event.block_height,
          txId: event.tx_id,
          txIndex: event.tx_index,
          duration,
          error,
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
