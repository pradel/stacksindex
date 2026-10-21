// oxlint-disable typescript/method-signature-style
import type { ClarityAbi } from "clarity-abitype";
import type { AnyRelations, EmptyRelations } from "drizzle-orm";
import type { PgQueryResultKind } from "drizzle-orm/pg-core";
import {
  Cause,
  Context,
  Effect,
  Exit,
  Fiber,
  ManagedRuntime,
  type LogLevel as EffectLogLevel,
} from "effect";

import type { ClarityJsonValue } from "../codec/index.ts";
import { type Database, IndexerDatabase, type IndexerDb } from "../database/index.ts";
import type {
  ContractFunctionArgs,
  ContractFunctionName,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "../datasources/api/index.ts";
import type { ChainOption } from "../lib/network.ts";
import type { EventHandler as EffectEventHandler, HandlerEvent } from "../lib/types.ts";
import {
  Indexer as IndexerService,
  type IndexerStatus,
  type LiveOptions,
  type RunResult,
  type Filter as EffectFilter,
  type TelemetryOptions,
} from "../runtime/index.ts";
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

/**
 * Context passed to a handler. `TRelations` types `db.query`: pass
 * `typeof relations` when the indexer was created with `relations`.
 */
export interface HandlerContext<TRelations extends AnyRelations = EmptyRelations> {
  /**
   * Indexer database scoped to the batch transaction: writes commit together
   * with the indexing checkpoint, or roll back with it.
   */
  db: IndexerDb<TRelations>;
  /** Read-only contract client pinned to the event's block height. */
  client: IndexingClient;
  /** Console logger configured with the runtime's log level. */
  logger: Logger;
}

export type EventHandler<TRelations extends AnyRelations = EmptyRelations> = (
  event: HandlerEvent,
  context: HandlerContext<TRelations>,
) => Promise<void> | void;

export interface Filter<TRelations extends AnyRelations = EmptyRelations> {
  /** Fully qualified contract identifier (e.g. `SP...contract-name`). */
  contractId: string;
  /** Async function called for every matching smart contract event. */
  handler: EventHandler<TRelations>;
  /** Start indexing from this block height. Defaults to the deployment block. */
  startBlock?: number;
  /** Stop at this block height, or `"latest"` for the current chain tip. */
  endBlock?: number | "latest";
}

export type LogLevel = EffectLogLevel.LogLevel;

export interface IndexerOptions<TRelations extends AnyRelations = EmptyRelations> {
  /** Database for sync storage, checkpoints and your own tables: `pglite(...)` or `postgres(...)`. */
  database: Database;
  /**
   * Folder of your drizzle-kit migrations, applied when the database opens,
   * after the indexer's own. Tracked in drizzle's default `drizzle.__drizzle_migrations`.
   */
  migrations?: string;
  /**
   * Drizzle relations from `defineRelations`, enabling `db.query` on
   * `indexer.db` and `context.db`.
   */
  relations?: TRelations;
  /** Which chain to index. Defaults to `"mainnet"`. */
  chain?: ChainOption;
  api?: {
    /** Overrides the chain's API URL. */
    url?: string;
    apiKey?: string;
  };
  /**
   * Number of blocks kept unfinalized behind the chain tip. Reorgs within this
   * depth are replayed; a reorg that replaces a finalized block fails with
   * `ReorgError`. Defaults to `6`.
   */
  finality?: number;
  /** How `live` follows new blocks: `transport`, `pollingInterval`, `webSocketUrl`. */
  live?: LiveOptions;
  /** Minimum log level for the console logger. Defaults to `"Info"`. */
  logLevel?: LogLevel;
  /** Pushes metrics over OTLP when `telemetry.otlp` is set; see `OtlpOptions`. */
  telemetry?: TelemetryOptions;
}

/**
 * Promise-native indexer. Owns the indexer database and the Stacks API
 * runtime; call `close()` (or use `await using`) when done.
 */
export interface Indexer<TRelations extends AnyRelations = EmptyRelations> {
  /**
   * Database handle outside any batch, to query your tables (API, reads) and
   * the indexer's. On PGlite, queries wait for the batch in progress.
   */
  readonly db: IndexerDb<TRelations>;
  /** Syncs and indexes one or more contracts up to the current chain tip. */
  run: (filters: Filter<TRelations> | Filter<TRelations>[]) => Promise<RunResult>;
  /**
   * Runs `run`, then follows new blocks and indexes them as they arrive.
   * Resolves once every filter reached its `endBlock`, or when `close()` is
   * called; rejects on a fatal error.
   */
  live: (filters: Filter<TRelations> | Filter<TRelations>[]) => Promise<void>;
  /** Current phase plus the stored checkpoint, anchor and per-contract sync progress. */
  status: () => Promise<IndexerStatus>;
  /** Flush pending metrics and release the database and runtime. Safe to call multiple times. */
  close: () => Promise<void>;
  [Symbol.asyncDispose]: () => Promise<void>;
}

const makeLogger = (runSync: (effect: Effect.Effect<void>) => void): Logger => {
  const log = (effect: Effect.Effect<void>): void => {
    runSync(effect);
  };

  const annotate = (annotations?: LogAnnotations) => Effect.annotateLogs(annotations ?? {});

  return {
    info: (message, annotations) => log(Effect.logInfo(message).pipe(annotate(annotations))),
    warn: (message, annotations) => log(Effect.logWarning(message).pipe(annotate(annotations))),
    error: (message, annotations) => log(Effect.logError(message).pipe(annotate(annotations))),
    debug: (message, annotations) => log(Effect.logDebug(message).pipe(annotate(annotations))),
    trace: (message, annotations) => log(Effect.logTrace(message).pipe(annotate(annotations))),
  };
};

const toEffectHandler =
  <TRelations extends AnyRelations>(
    handler: EventHandler<TRelations>,
    logger: Logger,
  ): EffectEventHandler =>
  (event, context) =>
    Effect.gen(function* () {
      // `context.db` is the transaction handle and its connection lives in the
      // Batch fiber's services, so awaited queries must run with them.
      const services = yield* Effect.context();
      const run = Effect.runPromiseWith(services);
      const thenableClient: unknown = toThenable(context.client, run);
      // SAFETY: toThenable wraps the Effect client so every method returns a thenable at run time.
      const client = thenableClient as IndexingClient;
      // SAFETY: The database was opened with the `relations` the handlers are typed with.
      const db = toThenable(context.db, run) as IndexerDb<TRelations>;

      yield* Effect.tryPromise({
        try: () => Promise.resolve(handler(event, { db, client, logger })),
        catch: (err) => err,
      });
    });

/**
 * Creates a promise-native indexer from a database and chain configuration.
 * The indexer is ready once the returned promise resolves: the database is
 * open and the indexer's own tables exist. `db.query` is typed only when
 * `relations` is passed, as drizzle only builds it from them.
 */
export function createIndexer<TRelations extends AnyRelations>(
  options: IndexerOptions<TRelations> & { relations: TRelations },
): Promise<Indexer<TRelations>>;

export function createIndexer(options: IndexerOptions): Promise<Indexer>;

export async function createIndexer<TRelations extends AnyRelations>(
  options: IndexerOptions<TRelations>,
): Promise<Indexer<TRelations>> {
  const runtime = ManagedRuntime.make(
    IndexerService.layerWithDatabase({
      database: options.database,
      migrations: options.migrations,
      relations: options.relations,
      chain: options.chain,
      api: options.api,
      finality: options.finality,
      live: options.live,
      logLevel: options.logLevel,
      telemetry: options.telemetry,
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
  // SAFETY: The database was opened with `options.relations`, typed as `TRelations`.
  const db = toThenable(Context.get(context, IndexerDatabase)) as IndexerDb<TRelations>;
  const logger = makeLogger((effect) => runtime.runSync(effect));
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

  const toEffectFilters = (filters: Filter<TRelations> | Filter<TRelations>[]): EffectFilter[] =>
    (Array.isArray(filters) ? filters : [filters]).map((filter) => ({
      contractId: filter.contractId,
      handler: toEffectHandler(filter.handler, logger),
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    }));

  return {
    db,
    run: async (filters) => {
      ensureOpen();

      return runtime.runPromise(service.run(toEffectFilters(filters)));
    },
    live: async (filters) => {
      ensureOpen();
      const fiber = runtime.runFork(service.live(toEffectFilters(filters)));
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
