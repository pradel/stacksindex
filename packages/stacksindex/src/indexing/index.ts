import { Cause, Context, Duration, Effect, Layer, Metric } from "effect";

import { type ClarityJsonValue, decodeHex } from "../codec/index.ts";
import type { IndexerDatabase } from "../database/index.ts";
import { readOnly, StacksClient, type StacksClientService } from "../datasources/api/index.ts";
import { EventDecodeError, HandlerExecutionError } from "../lib/errors.ts";
import {
  contractAttributes,
  indexingHandlerDuration,
  indexingHandlerErrors,
} from "../lib/metrics.ts";
import type { IndexingClient, PrintEvent } from "../lib/types.ts";
import type { DecodeIssue, ResolvedContract } from "../runtime/contracts.ts";
import { type StoredEvent, storedEventToPrintEvent } from "../sync-store/decode.ts";
import { HandlerClient } from "./client.ts";

export interface IndexingService {
  /**
   * Decodes every event in `events` and runs its contract's handler using the
   * ambient `IndexerDatabase`, so callers wrap it in
   * `IndexerDatabase.transaction` to commit the batch atomically. Returns the
   * number of events passed to handlers per contract id; prints skipped by
   * `onInvalid: "skip"` are not counted.
   */
  readonly executeBatch: (
    events: readonly StoredEvent[],
  ) => Effect.Effect<
    Map<string, number>,
    HandlerExecutionError | EventDecodeError,
    IndexerDatabase
  >;
}

export interface IndexingOptions {
  contracts: readonly ResolvedContract[];
  client: StacksClientService;
}

interface ContractRuntime {
  readonly spec: ResolvedContract;
  readonly duration: typeof indexingHandlerDuration;
  readonly errors: typeof indexingHandlerErrors;
}

const decodeValue = (hex: string): Effect.Effect<ClarityJsonValue, DecodeIssue> =>
  Effect.try({
    try: () => decodeHex(hex),
    catch: (cause) => ({ message: "Not a valid Clarity value", cause }),
  });

export const createIndexing = ({
  contracts,
  client: stacksClient,
}: IndexingOptions): IndexingService => {
  // Labelled once per contract so the per-event path does not allocate them.
  const runtimes = new Map<string, ContractRuntime>();

  for (const spec of contracts) {
    const attributes = contractAttributes(spec.name, spec.contractId);

    runtimes.set(spec.contractId, {
      spec,
      duration: Metric.withAttributes(indexingHandlerDuration, attributes),
      errors: Metric.withAttributes(indexingHandlerErrors, attributes),
    });
  }

  const logAnnotations = (row: StoredEvent, contract: string) =>
    Effect.annotateLogs({
      phase: "index",
      contract,
      contractId: row.contractId,
      blockHeight: Number(row.blockHeight),
      txId: row.txId,
      eventIndex: row.eventIndex,
    });

  /** Decodes the print into its event; `undefined` when `onInvalid: "skip"` drops it. */
  const decodeEvent = (
    row: StoredEvent,
    { spec }: ContractRuntime,
  ): Effect.Effect<PrintEvent<unknown> | undefined, EventDecodeError> =>
    decodeValue(row.valueHex).pipe(
      Effect.flatMap((value) =>
        spec.decode === undefined ? Effect.succeed(value) : spec.decode(value),
      ),
      Effect.map((data) => storedEventToPrintEvent(row, spec.name, data)),
      Effect.catch((issue) =>
        spec.onInvalid === "skip"
          ? Effect.logWarning(
              `Skipped a print that does not match its schema: ${issue.message}`,
            ).pipe(logAnnotations(row, spec.name), Effect.as(undefined))
          : Effect.fail(
              new EventDecodeError({
                contract: spec.name,
                contractId: spec.contractId,
                txId: row.txId,
                eventIndex: row.eventIndex,
                message: issue.message,
                cause: issue.cause,
              }),
            ),
      ),
    );

  const runHandler = (
    row: StoredEvent,
    runtime: ContractRuntime,
    event: PrintEvent<unknown>,
  ): Effect.Effect<void, HandlerExecutionError, IndexerDatabase> => {
    const { spec } = runtime;

    // SAFETY: `readOnly` runtime-dispatches on the presence of `abi`, mirroring both overloads, and pins the call to the event's block unless overridden.
    const client: IndexingClient = {
      // oxlint-disable-next-line typescript/no-explicit-any
      callReadOnly: ((options: any) =>
        readOnly(stacksClient.callReadFunction, {
          ...options,
          tip: options.tip ?? event.block.indexBlockHash,
        })) as IndexingClient["callReadOnly"],
    };

    const call = Effect.suspend(() => spec.handler(event)).pipe(
      Effect.provideService(HandlerClient, client),
    );

    return Effect.gen(function* () {
      // Failed calls are timed too: a slow handler that then throws is still slow.
      const [duration, exit] = yield* Effect.timed(Effect.exit(call));
      yield* Metric.update(runtime.duration, Duration.toMillis(duration));
      yield* exit;
    }).pipe(
      Effect.tap(() =>
        Effect.logDebug("Executed event handler").pipe(logAnnotations(row, spec.name)),
      ),
      Effect.withLogSpan("executeEvent"),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          // SAFETY: An interrupt-only cause contains no typed failures, so re-raising it preserves interruption semantics.
          return Effect.failCause(cause as Cause.Cause<never>);
        }

        return Effect.gen(function* () {
          yield* Metric.update(runtime.errors, 1);
          yield* Effect.logError(cause).pipe(logAnnotations(row, spec.name));

          return yield* new HandlerExecutionError({
            contract: spec.name,
            contractId: spec.contractId,
            cause: Cause.squash(cause),
          });
        });
      }),
    );
  };

  /** Runs one stored event; resolves whether its handler ran. */
  const executeRow = (
    row: StoredEvent,
  ): Effect.Effect<boolean, HandlerExecutionError | EventDecodeError, IndexerDatabase> => {
    const runtime = runtimes.get(row.contractId);

    if (runtime === undefined) {
      return Effect.logDebug("No handler for event").pipe(
        logAnnotations(row, row.contractId),
        Effect.as(false),
      );
    }

    return decodeEvent(row, runtime).pipe(
      Effect.flatMap((event) =>
        event === undefined
          ? Effect.succeed(false)
          : runHandler(row, runtime, event).pipe(Effect.as(true)),
      ),
    );
  };

  return {
    executeBatch(events) {
      return Effect.gen(function* () {
        const counts = new Map<string, number>();

        for (const row of events) {
          if (yield* executeRow(row)) {
            counts.set(row.contractId, (counts.get(row.contractId) ?? 0) + 1);
          }
        }

        return counts;
      });
    },
  };
};

export class Indexing extends Context.Service<Indexing, IndexingService>()(
  "stacksindex/indexing/Indexing",
) {
  static readonly layer = (options: {
    contracts: readonly ResolvedContract[];
  }): Layer.Layer<Indexing, never, StacksClient> =>
    Layer.effect(
      Indexing,
      Effect.gen(function* () {
        const client = yield* StacksClient;

        return Indexing.of(createIndexing({ contracts: options.contracts, client }));
      }),
    );
}
