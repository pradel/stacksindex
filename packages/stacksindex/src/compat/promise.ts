// oxlint-disable typescript/method-signature-style
import type { ClarityAbi, ContractFunctionArgs, ContractFunctionName } from "clarity-abitype";
import { Context, Effect, Exit, Layer, Scope, type LogLevel, type Schema } from "effect";

import {
  IndexerDatabase,
  migrate,
  type DatabaseConfig,
  type IndexerDb,
} from "../database/index.ts";
import type {
  CallReadResponse,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "../datasources/api/index.ts";
import type { EventHandler, HandlerEvent } from "../lib/types.ts";
import { loggerLayer } from "../logger/index.ts";
import {
  HistoricalRuntime,
  type Filter,
  type HistoricalRuntimeOptions,
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

export interface DatabaseResult {
  db: IndexerDb;
  migrate: (options?: { migrationsFolder?: string }) => Promise<void>;
  close: () => Promise<void>;
}

export async function createDatabase(config: DatabaseConfig): Promise<DatabaseResult> {
  const scope = await Effect.runPromise(Scope.make());

  const context = await Effect.runPromise(
    Layer.build(IndexerDatabase.layer(config)).pipe(Scope.provide(scope)),
  );

  const db = Context.get(context, IndexerDatabase);

  return {
    db: toThenable(db),
    migrate: async (options?: { migrationsFolder?: string }) => {
      await Effect.runPromise(migrate(options).pipe(Effect.provideService(IndexerDatabase, db)));
    },
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}

export interface PromiseIndexingClient {
  callReadOnly<
    const TAbi extends ClarityAbi | readonly unknown[],
    TFunctionName extends ContractFunctionName<TAbi, "read_only">,
    const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
  >(
    options: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>,
  ): PromiseLike<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>>;

  callReadOnly(options: UntypedCallReadOnlyFunctionParameters): PromiseLike<CallReadResponse>;
}

export type PromiseLogValue = string | number | boolean | bigint | null | undefined;

export type PromiseLogAnnotations = Readonly<Record<string, PromiseLogValue>>;

export interface PromiseLogger {
  info: (message: string, annotations?: PromiseLogAnnotations) => void;
  warn: (message: string, annotations?: PromiseLogAnnotations) => void;
  error: (message: string, annotations?: PromiseLogAnnotations) => void;
  debug: (message: string, annotations?: PromiseLogAnnotations) => void;
  trace: (message: string, annotations?: PromiseLogAnnotations) => void;
}

export interface PromiseHandlerContext {
  db: IndexerDb;
  client: PromiseIndexingClient;
  decode: <A>(schema: Schema.Schema<A>, repr: string) => Promise<A>;
  logger: PromiseLogger;
}

export type PromiseEventHandler = (
  event: HandlerEvent,
  context: PromiseHandlerContext,
) => Promise<void> | void;

export interface PromiseFilter {
  contractId: string;
  handler: PromiseEventHandler;
  startBlock?: number;
  endBlock?: number | "latest";
}

export interface PromiseHistoricalRuntimeOptions extends HistoricalRuntimeOptions {
  db: IndexerDb;
  level?: LogLevel.LogLevel;
}

export interface PromiseHistoricalRuntime {
  run: (filters: PromiseFilter[]) => Promise<void>;
}

const makePromiseLogger = (layer: Layer.Layer<never>): PromiseLogger => {
  const log = (effect: Effect.Effect<void>): void => {
    Effect.runSync(effect.pipe(Effect.provide(layer)));
  };

  const annotate = (annotations?: PromiseLogAnnotations) => Effect.annotateLogs(annotations ?? {});

  return {
    info: (message, annotations) => log(Effect.logInfo(message).pipe(annotate(annotations))),
    warn: (message, annotations) => log(Effect.logWarning(message).pipe(annotate(annotations))),
    error: (message, annotations) => log(Effect.logError(message).pipe(annotate(annotations))),
    debug: (message, annotations) => log(Effect.logDebug(message).pipe(annotate(annotations))),
    trace: (message, annotations) => log(Effect.logTrace(message).pipe(annotate(annotations))),
  };
};

const toEffectHandler =
  (handler: PromiseEventHandler, logger: PromiseLogger): EventHandler =>
  (event, context) => {
    const thenableClient: unknown = toThenable(context.client);
    // SAFETY: The adapter wraps the Effect client with toThenable, so every method returns a thenable at run time.
    const client = thenableClient as PromiseIndexingClient;

    return Effect.tryPromise({
      try: () =>
        Promise.resolve(
          handler(event, {
            db: toThenable(context.db),
            client,
            decode: (schema, repr) => Effect.runPromise(context.decode(schema, repr)),
            logger,
          }),
        ),
      catch: (err) => err,
    });
  };

export function createHistoricalRuntime(
  input: PromiseHistoricalRuntimeOptions,
): PromiseHistoricalRuntime {
  const { db, level, ...options } = input;
  const layer = loggerLayer({ level });
  const logger = makePromiseLogger(layer);

  return {
    run: (filters: PromiseFilter[]): Promise<void> =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* HistoricalRuntime;

          yield* runtime.run(
            filters.map((filter): Filter => ({
              contractId: filter.contractId,
              handler: toEffectHandler(filter.handler, logger),
              startBlock: filter.startBlock,
              endBlock: filter.endBlock,
            })),
          );
        }).pipe(
          Effect.provide(HistoricalRuntime.layer(options)),
          Effect.provideService(IndexerDatabase, db),
          Effect.provide(layer),
        ),
      ),
  };
}
