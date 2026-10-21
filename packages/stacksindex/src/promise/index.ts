// oxlint-disable typescript/method-signature-style
import type { ClarityAbi } from "clarity-abitype";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { PgQueryResultKind } from "drizzle-orm/pg-core";
import { Cause, Context, Effect, Exit, Fiber, ManagedRuntime, Predicate } from "effect";
import type { StandardSchemaV1 } from "effect/StandardSchema";

import type { ClarityJsonValue } from "../codec/index.ts";
import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import type {
  ContractFunctionArgs,
  ContractFunctionName,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "../datasources/api/index.ts";
import { HandlerClient } from "../indexing/client.ts";
import { ConfigurationError } from "../lib/errors.ts";
import type { CoreHandler, PrintEvent } from "../lib/types.ts";
import type { IndexerRuntimeOptions } from "../runtime/config.ts";
import {
  type ContractDefinitionBase,
  type ContractSpec,
  type DecodeIssue,
  validateContractDefinitions,
} from "../runtime/contracts.ts";
import { Indexer as IndexerService, type IndexerStatus, type RunResult } from "../runtime/index.ts";
import { toThenable } from "./thenable.ts";

// The promise API wraps database handles with `toThenable`, so every query
// Builder can be awaited directly; these augmentations expose that to TypeScript.
declare module "drizzle-orm/pg-core/effect/select" {
  interface PgEffectSelectBase<
    TTableName,
    TSelection,
    TSelectMode,
    TNullabilityMap,
    TDynamic,
    TExcludedMethods,
    TResult,
    TSelectedFields,
    TEffectHKT,
  > extends PromiseLike<TResult> {}
}

declare module "drizzle-orm/pg-core/effect/insert" {
  interface PgEffectInsertBase<
    TTable,
    TQueryResult,
    TSelectedFields,
    TReturning,
    TDynamic,
    TExcludedMethods,
    TEffectHKT,
  > extends PromiseLike<
    TReturning extends undefined ? PgQueryResultKind<TQueryResult, never> : TReturning[]
  > {}
}

declare module "drizzle-orm/pg-core/effect/update" {
  interface PgEffectUpdateBase<
    TTable,
    TQueryResult,
    TFrom,
    TSelectedFields,
    TReturning,
    TNullabilityMap,
    TJoins,
    TDynamic,
    TExcludedMethods,
    TEffectHKT,
  > extends PromiseLike<
    TReturning extends undefined ? PgQueryResultKind<TQueryResult, never> : TReturning[]
  > {}
}

declare module "drizzle-orm/pg-core/effect/delete" {
  interface PgEffectDeleteBase<
    TTable,
    TQueryResult,
    TSelectedFields,
    TReturning,
    TDynamic,
    TExcludedMethods,
    TEffectHKT,
  > extends PromiseLike<
    TReturning extends undefined ? PgQueryResultKind<TQueryResult, never> : TReturning[]
  > {}
}

declare module "drizzle-orm/pg-core/effect/raw" {
  interface PgEffectRaw<TResult, TEffectHKT> extends PromiseLike<TResult> {}
}

declare module "drizzle-orm/pg-core/effect/query" {
  interface PgEffectRelationalQuery<TResult, TEffectHKT> extends PromiseLike<TResult> {}
}

declare module "drizzle-orm/pg-core/effect/count" {
  interface PgEffectCountBuilder<TEffectHKT> extends PromiseLike<number> {}
}

export type LogValue = string | number | boolean | bigint | null | undefined;

export type LogAnnotations = Readonly<Record<string, LogValue>>;

/** Console logger installed by the promise runtime. */
export interface Logger {
  info: (message: string, annotations?: LogAnnotations) => void;
  warn: (message: string, annotations?: LogAnnotations) => void;
  error: (message: string, annotations?: LogAnnotations) => void;
  debug: (message: string, annotations?: LogAnnotations) => void;
  trace: (message: string, annotations?: LogAnnotations) => void;
}

export interface IndexingClient {
  callReadOnly<
    const TAbi extends ClarityAbi | readonly unknown[],
    TFunctionName extends ContractFunctionName<TAbi, "read_only">,
    const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
  >(
    options: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>,
  ): Promise<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>>;

  callReadOnly(options: UntypedCallReadOnlyFunctionParameters): Promise<ClarityJsonValue>;
}

/** A contract to index. */
export interface ContractDefinition extends ContractDefinitionBase {
  /**
   * Standard Schema (zod, valibot, arktype, Effect's `Schema.toStandardSchemaV1`)
   * parsing every print into `event.data`. Without it, `data` is the decoded
   * Clarity value.
   */
  readonly print?: StandardSchemaV1;
}

export type ContractDefinitions = Readonly<Record<string, ContractDefinition>>;

/** `event.data` of a contract: its `print` schema's output, or the decoded Clarity value. */
export type PrintData<TContract extends ContractDefinition> = TContract extends {
  readonly print: infer TSchema extends StandardSchemaV1;
}
  ? StandardSchemaV1.InferOutput<TSchema>
  : ClarityJsonValue;

/** Context passed to a handler. */
export interface HandlerContext<TRelations extends AnyRelations = EmptyRelations> {
  /**
   * Indexer database scoped to the batch transaction: writes commit together
   * with the indexing checkpoint, or roll back with it. `db.query` is typed by
   * the definition's `relations`.
   */
  db: IndexerDb<TRelations>;
  /** Read-only contract client pinned to the event's block. */
  client: IndexingClient;
  /** Console logger configured with the runtime's log level. */
  logger: Logger;
}

export type EventHandler<
  TContract extends ContractDefinition = ContractDefinition,
  TRelations extends AnyRelations = EmptyRelations,
> = (
  event: PrintEvent<PrintData<TContract>>,
  context: HandlerContext<TRelations>,
) => Promise<void> | void;

/** One handler per defined contract. */
export type Handlers<TContracts extends ContractDefinitions, TRelations extends AnyRelations> = {
  readonly [TName in keyof TContracts]: EventHandler<TContracts[TName], TRelations>;
};

export interface CreateOptions<
  TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
> extends IndexerRuntimeOptions {
  readonly handlers: Handlers<TContracts, TRelations>;
}

/**
 * Promise-native indexer. Owns the database and the Stacks API runtime; call
 * `close()` (or use `await using`) when done.
 */
export interface Indexer<TRelations extends AnyRelations = EmptyRelations> {
  /**
   * Database handle outside any batch, to query your tables (API, reads) and
   * the indexer's. On PGlite, queries wait for the batch in progress.
   */
  readonly db: IndexerDb<TRelations>;
  /** Syncs and indexes every contract up to the current chain tip. */
  run: () => Promise<RunResult>;
  /**
   * Runs `run`, then follows new blocks and indexes them as they arrive.
   * Resolves once every contract reached its `endBlock`, or when `close()` is
   * called; rejects on a fatal error.
   */
  live: () => Promise<void>;
  /** Current phase plus the stored checkpoint, anchor and per-contract sync progress. */
  status: () => Promise<IndexerStatus>;
  /** Flush pending metrics and release the database and runtime. Safe to call multiple times. */
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

export interface IndexerDefinition<
  TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
> {
  readonly contracts: TContracts;
  /** Types a handler defined apart from `create`, e.g. in its own module. */
  handler<TName extends keyof TContracts & string>(
    name: TName,
    handler: EventHandler<TContracts[TName], TRelations>,
  ): EventHandler<TContracts[TName], TRelations>;
  /**
   * Opens the database, applies the indexer's migrations and `migrations`,
   * and resolves once the indexer is ready.
   */
  create(options: CreateOptions<TContracts, TRelations>): Promise<Indexer<TRelations>>;
}

const makeLogger = (runSync: (effect: Effect.Effect<void>) => void): Logger => {
  const annotate = (annotations?: LogAnnotations) => Effect.annotateLogs(annotations ?? {});

  return {
    info: (message, annotations) => runSync(Effect.logInfo(message).pipe(annotate(annotations))),
    warn: (message, annotations) => runSync(Effect.logWarning(message).pipe(annotate(annotations))),
    error: (message, annotations) => runSync(Effect.logError(message).pipe(annotate(annotations))),
    debug: (message, annotations) => runSync(Effect.logDebug(message).pipe(annotate(annotations))),
    trace: (message, annotations) => runSync(Effect.logTrace(message).pipe(annotate(annotations))),
  };
};

const formatIssues = (issues: readonly StandardSchemaV1.Issue[]): string =>
  issues
    .map((issue) => {
      const path = issue.path?.map((segment) =>
        Predicate.hasProperty(segment, "key") ? String(segment.key) : String(segment),
      );

      return path === undefined || path.length === 0
        ? issue.message
        : `${path.join(".")}: ${issue.message}`;
    })
    .join("; ");

const fromValidation = (
  result: StandardSchemaV1.Result<unknown>,
): Effect.Effect<unknown, DecodeIssue> =>
  result.issues === undefined
    ? Effect.succeed(result.value)
    : Effect.fail({ message: formatIssues(result.issues), cause: result.issues });

/** Parses a print with a Standard Schema, sync or async. */
const standardDecoder =
  (schema: StandardSchemaV1) =>
  (value: ClarityJsonValue): Effect.Effect<unknown, DecodeIssue> =>
    Effect.suspend(() => {
      const result = schema["~standard"].validate(value);

      return result instanceof Promise
        ? Effect.tryPromise({
            try: () => result,
            catch: (cause): DecodeIssue => ({ message: "The print schema failed", cause }),
          }).pipe(Effect.flatMap(fromValidation))
        : fromValidation(result);
    }).pipe(
      Effect.catchDefect((cause) =>
        Effect.fail<DecodeIssue>({ message: "The print schema failed", cause }),
      ),
    );

/**
 * Runs a promise handler inside the batch fiber: awaited queries run with its
 * services, so `context.db` uses the open transaction connection.
 */
const toCoreHandler =
  <TRelations extends AnyRelations>(
    handler: EventHandler<ContractDefinition, TRelations>,
  ): CoreHandler =>
  (event) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<IndexerDatabase | HandlerClient>();
      const run = Effect.runPromiseWith(services);
      const runSync = Effect.runSyncWith(services);
      // SAFETY: The database was opened with the `relations` the handlers are typed with.
      const db = toThenable(Context.get(services, IndexerDatabase), run) as IndexerDb<TRelations>;
      const thenableClient: unknown = toThenable(Context.get(services, HandlerClient), run);
      // SAFETY: toThenable wraps the Effect client so every method returns a thenable at run time.
      const client = thenableClient as IndexingClient;
      // SAFETY: The runtime parsed `data` with this contract's `print` schema, which `EventHandler` types it with.
      const typedEvent = event as PrintEvent;

      const logger = makeLogger((effect) => {
        runSync(effect);
      });

      yield* Effect.tryPromise({
        try: () => Promise.resolve(handler(typedEvent, { db, client, logger })),
        catch: (err) => err,
      });
    });

const toContractSpecs = <TContracts extends ContractDefinitions, TRelations extends AnyRelations>(
  contracts: TContracts,
  handlers: Handlers<TContracts, TRelations>,
): ContractSpec[] => {
  for (const name of Object.keys(handlers)) {
    if (!Object.hasOwn(contracts, name)) {
      throw new ConfigurationError({ message: `handlers.${name}: no contract named "${name}".` });
    }
  }

  return Object.entries(contracts).map(([name, contract]) => {
    const handler: EventHandler<ContractDefinition, TRelations> | undefined = handlers[name];

    if (!Predicate.isFunction(handler)) {
      throw new ConfigurationError({ message: `handlers.${name}: missing handler.` });
    }

    return {
      name,
      contractId: contract.id,
      startBlock: contract.startBlock,
      endBlock: contract.endBlock,
      onInvalid: contract.onInvalid ?? "fail",
      decode: contract.print === undefined ? undefined : standardDecoder(contract.print),
      handler: toCoreHandler(handler),
    };
  });
};

/**
 * Defines the contracts to index and, optionally, the drizzle `relations`
 * typing `db.query`. Throws `ConfigurationError` on an invalid definition.
 */
export function defineIndexer<
  const TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
>(definition: {
  readonly contracts: TContracts;
  readonly relations: TRelations;
}): IndexerDefinition<TContracts, TRelations>;

export function defineIndexer<const TContracts extends ContractDefinitions>(definition: {
  readonly contracts: TContracts;
}): IndexerDefinition<TContracts, EmptyRelations>;

export function defineIndexer<
  const TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
>(definition: {
  readonly contracts: TContracts;
  readonly relations?: TRelations;
}): IndexerDefinition<TContracts, TRelations> {
  validateContractDefinitions(definition.contracts);

  return {
    contracts: definition.contracts,
    handler: (_name, handler) => handler,
    create: (options) => createIndexer(definition.contracts, definition.relations, options),
  };
}

async function createIndexer<
  TContracts extends ContractDefinitions,
  TRelations extends AnyRelations,
>(
  contracts: TContracts,
  relations: TRelations | undefined,
  options: CreateOptions<TContracts, TRelations>,
): Promise<Indexer<TRelations>> {
  const specs = toContractSpecs(contracts, options.handlers);

  const runtime = ManagedRuntime.make(
    IndexerService.layerWithDatabase({
      database: options.database,
      migrations: options.migrations,
      relations,
      chain: options.chain,
      api: options.api,
      finality: options.finality,
      live: options.live,
      logLevel: options.logLevel,
      telemetry: options.telemetry,
      contracts: specs,
    }),
  );

  // Build the layer eagerly so configuration, connection and migration errors reject here.
  let context: Awaited<ReturnType<typeof runtime.context>>;

  try {
    context = await runtime.context();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }

  const service = Context.get(context, IndexerService);
  // SAFETY: The database was opened with `relations`, typed as `TRelations`.
  const db = toThenable(Context.get(context, IndexerDatabase)) as IndexerDb<TRelations>;
  let closed = false;
  const liveFibers = new Set<Fiber.Fiber<void, unknown>>();

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }

    closed = true;
    await Promise.all(Array.from(liveFibers, (fiber) => Effect.runPromise(Fiber.interrupt(fiber))));
    await runtime.dispose();
  };

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error("Indexer is closed. Create a new indexer to run more syncs.");
    }
  };

  return {
    db,
    run: async () => {
      ensureOpen();

      return runtime.runPromise(service.run);
    },
    live: async () => {
      ensureOpen();
      const fiber = runtime.runFork(service.live);
      liveFibers.add(fiber);

      try {
        const exit = await Effect.runPromise(Fiber.await(fiber));

        // `close()` interrupts live indexing; that ends it without an error.
        if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
          throw Cause.squash(exit.cause);
        }
      } finally {
        liveFibers.delete(fiber);
      }
    },
    status: async () => {
      ensureOpen();

      return runtime.runPromise(service.status);
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
