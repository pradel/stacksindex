import { Cause, Context, Duration, Effect, Layer, Metric } from "effect";

import { type ClarityJsonValue, decodeHex } from "../codec/index.ts";
import type { IndexerDatabase } from "../database/index.ts";
import { readOnly, StacksClient, type StacksClientService } from "../datasources/api/index.ts";
import {
  BlockHandlerExecutionError,
  EventDecodeError,
  HandlerExecutionError,
} from "../lib/errors.ts";
import {
  blockSourceAttributes,
  contractAttributes,
  indexingHandlerDuration,
  indexingHandlerErrors,
} from "../lib/metrics.ts";
import type { BlockEvent, EventBlock, IndexingClient, PrintEvent } from "../lib/types.ts";
import type { ResolvedBlockSource } from "../runtime/blocks.ts";
import type { DecodeIssue, ResolvedContract } from "../runtime/contracts.ts";
import {
  type IndexRow,
  type StoredBlockSourceRow,
  storedBlockToBlockEvent,
  type StoredEvent,
  storedEventToPrintEvent,
} from "../sync-store/decode.ts";
import { HandlerClient } from "./client.ts";

export interface IndexingService {
  /**
   * Runs every row's handler using the ambient `IndexerDatabase`: decodes a
   * print and runs its contract's handler, or runs a block source's handler
   * at its block. Callers wrap it in `IndexerDatabase.transaction` to commit
   * the batch atomically. Returns the number of events passed to handlers per
   * definition name; prints skipped by `onInvalid: "skip"` are not counted.
   */
  readonly executeBatch: (
    rows: readonly IndexRow[],
  ) => Effect.Effect<
    Map<string, number>,
    HandlerExecutionError | BlockHandlerExecutionError | EventDecodeError,
    IndexerDatabase
  >;
}

export interface IndexingOptions {
  contracts: readonly ResolvedContract[];
  blocks?: readonly ResolvedBlockSource[];
  client: StacksClientService;
}

interface ContractRuntime {
  readonly spec: ResolvedContract;
  readonly duration: typeof indexingHandlerDuration;
  readonly errors: typeof indexingHandlerErrors;
}

interface BlockSourceRuntime {
  readonly spec: ResolvedBlockSource;
  readonly duration: typeof indexingHandlerDuration;
  readonly errors: typeof indexingHandlerErrors;
}

/** Annotates the logs of a handler call: a print's contract and position, or a block source's run. */
type AnnotateLogs = <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

const decodeValue = (hex: string): Effect.Effect<ClarityJsonValue, DecodeIssue> =>
  Effect.try({
    try: () => decodeHex(hex),
    catch: (cause) => ({ message: "Not a valid Clarity value", cause }),
  });

export const createIndexing = ({
  contracts,
  blocks = [],
  client: stacksClient,
}: IndexingOptions): IndexingService => {
  // Labelled once per contract and block source so the per-event path does not allocate them.
  const runtimes = new Map<string, ContractRuntime>();
  const blockRuntimes = new Map<string, BlockSourceRuntime>();

  for (const spec of contracts) {
    const attributes = contractAttributes(spec.name, spec.contractId);

    runtimes.set(spec.contractId, {
      spec,
      duration: Metric.withAttributes(indexingHandlerDuration, attributes),
      errors: Metric.withAttributes(indexingHandlerErrors, attributes),
    });
  }

  for (const spec of blocks) {
    const attributes = blockSourceAttributes(spec.name);

    blockRuntimes.set(spec.name, {
      spec,
      duration: Metric.withAttributes(indexingHandlerDuration, attributes),
      errors: Metric.withAttributes(indexingHandlerErrors, attributes),
    });
  }

  const eventAnnotations = (row: StoredEvent, contract: string): AnnotateLogs =>
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
            ).pipe(eventAnnotations(row, spec.name), Effect.as(undefined))
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

  /**
   * Runs `handler` with the read-only client pinned to `block`, timing it and
   * turning a failure into the error `toError` builds from its cause.
   */
  const runHandler = <E>(
    handler: () => Effect.Effect<void, unknown, IndexerDatabase | HandlerClient>,
    block: EventBlock,
    runtime: ContractRuntime | BlockSourceRuntime,
    toError: (cause: unknown) => E,
    annotate: AnnotateLogs,
  ): Effect.Effect<void, E, IndexerDatabase> => {
    // SAFETY: `readOnly` runtime-dispatches on the presence of `abi`, mirroring both overloads, and pins the call to the event's block unless overridden.
    const client: IndexingClient = {
      // oxlint-disable-next-line typescript/no-explicit-any
      callReadOnly: ((options: any) =>
        readOnly(stacksClient.callReadFunction, {
          ...options,
          tip: options.tip ?? block.indexBlockHash,
        })) as IndexingClient["callReadOnly"],
    };

    const call = Effect.suspend(handler).pipe(Effect.provideService(HandlerClient, client));

    return Effect.gen(function* () {
      // Failed calls are timed too: a slow handler that then throws is still slow.
      const [duration, exit] = yield* Effect.timed(Effect.exit(call));
      yield* Metric.update(runtime.duration, Duration.toMillis(duration));
      yield* exit;
    }).pipe(
      Effect.tap(() => Effect.logDebug("Executed event handler").pipe(annotate)),
      Effect.withLogSpan("executeEvent"),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          // SAFETY: An interrupt-only cause contains no typed failures, so re-raising it preserves interruption semantics.
          return Effect.failCause(cause as Cause.Cause<never>);
        }

        return Effect.gen(function* () {
          yield* Metric.update(runtime.errors, 1);
          yield* Effect.logError(cause).pipe(annotate);

          return yield* Effect.fail(toError(Cause.squash(cause)));
        });
      }),
    );
  };

  /** Runs one stored event; resolves its contract's name when its handler ran. */
  const executeEvent = (
    row: StoredEvent,
  ): Effect.Effect<
    string | undefined,
    HandlerExecutionError | EventDecodeError,
    IndexerDatabase
  > => {
    const runtime = runtimes.get(row.contractId);

    if (runtime === undefined) {
      return Effect.logDebug("No handler for event").pipe(
        eventAnnotations(row, row.contractId),
        Effect.as(undefined),
      );
    }

    const { spec } = runtime;

    return decodeEvent(row, runtime).pipe(
      Effect.flatMap((event) =>
        event === undefined
          ? Effect.succeed(undefined)
          : runHandler(
              () => spec.handler(event),
              event.block,
              runtime,
              (cause) =>
                new HandlerExecutionError({
                  contract: spec.name,
                  contractId: spec.contractId,
                  cause,
                }),
              eventAnnotations(row, spec.name),
            ).pipe(Effect.as(spec.name)),
      ),
    );
  };

  /** Runs one block source at its block; resolves its name when its handler ran. */
  const executeBlock = (
    row: StoredBlockSourceRow,
  ): Effect.Effect<string | undefined, BlockHandlerExecutionError, IndexerDatabase> => {
    const annotate: AnnotateLogs = Effect.annotateLogs({
      phase: "index",
      blocks: row.source,
      blockHeight: Number(row.blockHeight),
    });

    const runtime = blockRuntimes.get(row.source);

    if (runtime === undefined) {
      return Effect.logDebug("No handler for block source").pipe(annotate, Effect.as(undefined));
    }

    const event: BlockEvent = storedBlockToBlockEvent(row);

    return runHandler(
      () => runtime.spec.handler(event),
      event.block,
      runtime,
      (cause) =>
        new BlockHandlerExecutionError({
          name: row.source,
          blockHeight: Number(row.blockHeight),
          cause,
        }),
      annotate,
    ).pipe(Effect.as(row.source));
  };

  return {
    executeBatch(rows) {
      return Effect.gen(function* () {
        const counts = new Map<string, number>();

        for (const row of rows) {
          const name =
            row.eventType === "block" ? yield* executeBlock(row) : yield* executeEvent(row);

          if (name !== undefined) {
            counts.set(name, (counts.get(name) ?? 0) + 1);
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
    blocks?: readonly ResolvedBlockSource[];
  }): Layer.Layer<Indexing, never, StacksClient> =>
    Layer.effect(
      Indexing,
      Effect.gen(function* () {
        const client = yield* StacksClient;

        return Indexing.of(
          createIndexing({ contracts: options.contracts, blocks: options.blocks, client }),
        );
      }),
    );
}
