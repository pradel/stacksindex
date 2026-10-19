import { Cause, Context, Duration, Effect, Layer, Metric } from "effect";

import { decodeClarityWithSchema } from "../codec/index.ts";
import { type IndexerDb, IndexerDatabase } from "../database/index.ts";
import { readOnly, StacksClient, type StacksClientService } from "../datasources/api/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import { indexingHandlerDuration, indexingHandlerErrors } from "../lib/metrics.ts";
import type {
  EventHandler,
  HandlerContext,
  HandlerEvent,
  Handlers,
  IndexingClient,
} from "../lib/types.ts";

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
  // Labelled once per contract so the per-event path does not allocate them.
  const contractHandlers = new Map<
    string,
    {
      handler: EventHandler;
      duration: typeof indexingHandlerDuration;
      errors: typeof indexingHandlerErrors;
    }
  >();

  for (const [contract, handler] of Object.entries(handlers)) {
    if (handler !== undefined) {
      contractHandlers.set(contract, {
        handler,
        duration: Metric.withAttributes(indexingHandlerDuration, { contract }),
        errors: Metric.withAttributes(indexingHandlerErrors, { contract }),
      });
    }
  }

  /**
   * The node pins read-only calls by index block hash, and events only carry
   * their block height. Heights are resolved once per batch: a batch indexes
   * blocks from a single pass, and a reorg found by a later pass replays the
   * batch with fresh lookups.
   */
  const eventIndexBlockHash = (height: number, indexBlockHashes: Map<number, string>) => {
    const cached = indexBlockHashes.get(height);

    return cached === undefined
      ? stacksClient.getBlock(height).pipe(
          Effect.map((block) => block.index_block_hash),
          Effect.tap((hash) => Effect.sync(() => indexBlockHashes.set(height, hash))),
        )
      : Effect.succeed(cached);
  };

  const executeEvent = (
    event: HandlerEvent,
    db: IndexerDb,
    indexBlockHashes: Map<number, string>,
  ): Effect.Effect<void, HandlerExecutionError> => {
    const contractHandler = contractHandlers.get(event.contract_log.contract_id);

    if (contractHandler === undefined) {
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

    const { handler } = contractHandler;

    return Effect.gen(function* executeEvent() {
      // SAFETY: `readOnly` runtime-dispatches on the presence of `abi`, mirroring both overloads, and pins the call to the event's block unless overridden.
      const client: IndexingClient = {
        // oxlint-disable-next-line typescript/no-explicit-any
        callReadOnly: ((options: any) =>
          Effect.gen(function* () {
            const tip: string =
              options.tip ?? (yield* eventIndexBlockHash(event.block_height, indexBlockHashes));

            return yield* readOnly(stacksClient.callReadFunction, { ...options, tip });
          })) as IndexingClient["callReadOnly"],
      };

      // SAFETY: Schemas decoded here are pure, so the decode effect has no remaining requirements and its error channel widens to `unknown`.
      const handlerContext: HandlerContext = {
        db,
        client,
        decode: (schema, hex) =>
          decodeClarityWithSchema(schema)(hex) as Effect.Effect<(typeof schema)["Type"], unknown>,
      };

      const call = Effect.gen(function* () {
        const result = yield* Effect.try({
          try: () => handler(event, handlerContext),
          catch: (err) => err,
        });

        yield* result;
      });

      // Failed calls are timed too: a slow handler that then throws is still slow.
      const [duration, exit] = yield* Effect.timed(Effect.exit(call));
      yield* Metric.update(contractHandler.duration, Duration.toMillis(duration));
      yield* exit;
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
          yield* Metric.update(contractHandler.errors, 1);
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
        const indexBlockHashes = new Map<number, string>();

        for (const event of events) {
          yield* executeEvent(event, db, indexBlockHashes);
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
