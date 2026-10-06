// oxlint-disable typescript/method-signature-style
import type { ClarityAbi } from "clarity-abitype";
import { Context, Effect, ManagedRuntime, type LogLevel as EffectLogLevel } from "effect";

import type { ClarityJsonValue } from "../codec/index.ts";
import {
  type DatabaseConfig,
  IndexerDatabase,
  migrate,
  type IndexerDb,
} from "../database/index.ts";
import type {
  ContractFunctionArgs,
  ContractFunctionName,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "../datasources/api/index.ts";
import type { NetworkOption } from "../lib/network.ts";
import type { EventHandler as EffectEventHandler, HandlerEvent } from "../lib/types.ts";
import {
  HistoricalRuntime as HistoricalRuntimeService,
  type RunResult,
} from "../runtime/historical.ts";
import { toThenable } from "./thenable.ts";

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

export interface HandlerContext {
  /** Transactional indexer database handle for the event being processed. */
  db: IndexerDb;
  /** Read-only contract client pinned to the event's block height. */
  client: IndexingClient;
  /** Console logger configured with the runtime's log level. */
  logger: Logger;
}

export type EventHandler = (event: HandlerEvent, context: HandlerContext) => Promise<void> | void;

export interface Filter {
  /** Fully qualified contract identifier (e.g. `SP...contract-name`). */
  contractId: string;
  /** Async function called for every matching smart contract event. */
  handler: EventHandler;
  /** Start indexing from this block height. Defaults to the deployment block. */
  startBlock?: number;
  /** Stop at this block height, or `"latest"` for the current chain tip. */
  endBlock?: number | "latest";
}

export type LogLevel = EffectLogLevel.LogLevel;

export interface HistoricalRuntimeOptions {
  /** Database used for sync storage and checkpoints. */
  database: DatabaseConfig;
  /** Which chain to index. Defaults to `"mainnet"`. */
  network?: NetworkOption;
  api?: {
    /** Overrides the network's default API endpoint. */
    baseUrl?: string;
    apiKey?: string;
  };
  /** Minimum log level for the console logger. Defaults to `"Info"`. */
  logLevel?: LogLevel;
}

/**
 * Promise-native historical indexer. Owns the indexer database and the
 * Stacks API runtime; call `close()` (or use `await using`) when done.
 */
export interface HistoricalRuntime {
  /** Indexer database handle, useful to inspect sync progress and cached data. */
  readonly db: IndexerDb;
  /** Run pending migrations on the indexer database. */
  migrate: (options?: { migrationsFolder?: string }) => Promise<void>;
  /** Historical sync for one or more contracts. */
  run: (filters: Filter | Filter[]) => Promise<RunResult>;
  /** Release the database and runtime resources. Safe to call multiple times. */
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
  (handler: EventHandler, logger: Logger): EffectEventHandler =>
  (event, context) => {
    const thenableClient: unknown = toThenable(context.client);
    // SAFETY: toThenable wraps the Effect client so every method returns a thenable at run time.
    const client = thenableClient as IndexingClient;

    return Effect.tryPromise({
      try: () =>
        Promise.resolve(
          handler(event, {
            db: toThenable(context.db),
            client,
            logger,
          }),
        ),
      catch: (err) => err,
    });
  };

/**
 * Creates a promise-native historical indexer from a database and network
 * configuration. The runtime is ready once the returned promise resolves.
 */
export async function createHistoricalRuntime(
  options: HistoricalRuntimeOptions,
): Promise<HistoricalRuntime> {
  const runtime = ManagedRuntime.make(
    HistoricalRuntimeService.layerWithDatabase({
      database: options.database,
      network: options.network,
      api: options.api,
      logLevel: options.logLevel,
    }),
  );

  // Build the layer eagerly so configuration and connection errors reject here.
  let context: Awaited<ReturnType<typeof runtime.context>>;

  try {
    context = await runtime.context();
  } catch (error) {
    await runtime.dispose();
    throw error;
  }

  const service = Context.get(context, HistoricalRuntimeService);
  const db = toThenable(Context.get(context, IndexerDatabase));
  const logger = makeLogger((effect) => runtime.runSync(effect));
  let closed = false;

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }

    closed = true;
    await runtime.dispose();
  };

  const ensureOpen = (): void => {
    if (closed) {
      throw new Error("HistoricalRuntime is closed. Create a new runtime to run more syncs.");
    }
  };

  return {
    db,
    migrate: async (migrateOptions) => {
      ensureOpen();
      await runtime.runPromise(migrate(migrateOptions));
    },
    run: async (filters) => {
      ensureOpen();
      const normalized = Array.isArray(filters) ? filters : [filters];

      return runtime.runPromise(
        service.run(
          normalized.map((filter) => ({
            contractId: filter.contractId,
            handler: toEffectHandler(filter.handler, logger),
            startBlock: filter.startBlock,
            endBlock: filter.endBlock,
          })),
        ),
      );
    },
    close,
    [Symbol.asyncDispose]: close,
  };
}
