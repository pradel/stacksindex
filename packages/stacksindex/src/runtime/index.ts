import type { AnyRelations } from "drizzle-orm";
import { Cause, Context, Effect, Exit, Layer, Metric, Ref, Scope, Semaphore } from "effect";
import { Socket } from "effect/socket";

import { IndexerDatabase } from "../database/index.ts";
import { StacksClient } from "../datasources/api/index.ts";
import {
  type ConfigurationError,
  type DatabaseError,
  LockError,
  type MigrationError,
  type SyncStoreError,
} from "../lib/errors.ts";
import { loggerLayer } from "../logger/index.ts";
import { Sync } from "../sync/index.ts";
import { telemetryLayer } from "../telemetry/index.ts";
import {
  type IndexerError,
  type IndexerOptions,
  type IndexerRuntimeOptions,
  resolveIndexerConfig,
} from "./config.ts";
import type { ContractSpec } from "./contracts.ts";
import { resetIndexing } from "./definition.ts";
import { runHistorical, type RunResult } from "./historical.ts";
import { runLive } from "./realtime.ts";
import { type IndexerStatus, readIndexerStatus, RunPhase } from "./status.ts";

export type { IndexerError, IndexerOptions, IndexerRuntimeOptions, LiveOptions } from "./config.ts";

export type { ContractRunResult, RunResult } from "./historical.ts";

export type { ContractStatus, IndexerPhase, IndexerStatus } from "./status.ts";

export type { OtlpOptions, TelemetryOptions } from "../telemetry/index.ts";

/** The indexer, bound to the contracts and handlers it was built with. */
export interface IndexerService {
  /**
   * Syncs and indexes every contract up to the chain tip read at the start of
   * the run, then returns.
   */
  readonly run: Effect.Effect<RunResult, IndexerError>;
  /**
   * Runs `run`, then follows new blocks and indexes them as they arrive. Ends
   * once every contract reached its `endBlock`; runs until interrupted when a
   * contract has none.
   */
  readonly live: Effect.Effect<void, IndexerError>;
  /** Current phase plus the stored checkpoint, anchor and per-contract sync progress. */
  readonly status: Effect.Effect<IndexerStatus, SyncStoreError>;
  /**
   * Makes the next `run` or `live` replay every stored event through the
   * handlers, keeping the fetched chain data. `clearTables` empties the
   * tables the handlers write, in the same transaction. Contracts added or
   * whose block range changed are fetched again over their range. Fails with
   * `LockError` while `run` or `live` is running.
   */
  readonly reindex: <E = never>(
    clearTables?: Effect.Effect<void, E, IndexerDatabase>,
  ) => Effect.Effect<void, E | LockError | SyncStoreError | DatabaseError>;
}

export class Indexer extends Context.Service<Indexer, IndexerService>()(
  "stacksindex/runtime/Indexer",
) {
  static readonly layer = (
    options: IndexerOptions & { readonly contracts: readonly ContractSpec[] },
  ): Layer.Layer<Indexer, ConfigurationError, IndexerDatabase> =>
    Layer.unwrap(
      resolveIndexerConfig({
        chain: options.chain,
        api: options.api,
        finality: options.finality,
        live: options.live,
      }).pipe(
        Effect.map((config) =>
          Layer.effect(
            Indexer,
            Effect.gen(function* () {
              const sync = yield* Sync;
              const client = yield* StacksClient;
              const database = yield* IndexerDatabase;
              const webSocketConstructor = yield* Socket.WebSocketConstructor;
              const phase = yield* RunPhase;

              // Concurrent calls share the phase and the database lock: only a
              // Call starting while none is active takes the lock and moves the
              // Phase to "backfill", and only the last call to end releases it and
              // Sets the outcome. `runLive` moves it to "live" once it follows new heads.
              const activeCalls = yield* Ref.make(0);
              const lockScope = yield* Ref.make<Scope.Closeable | undefined>(undefined);
              // Serializes taking and releasing the lock with `reindex`.
              const gate = yield* Semaphore.make(1);

              const lock = Effect.gen(function* () {
                const scope = yield* Scope.make();

                const locked = yield* IndexerDatabase.lock(config.chainId).pipe(
                  Scope.provide(scope),
                  Effect.provideService(IndexerDatabase, database),
                  Effect.onError(() => Scope.close(scope, Exit.void)),
                );

                if (!locked) {
                  yield* Scope.close(scope, Exit.void);

                  return yield* new LockError({
                    chainId: config.chainId,
                    message: `Another indexer of chain ${config.chainId} is running against this database; stop it first.`,
                  });
                }

                return scope;
              });

              const trackRun = <A>(
                effect: Effect.Effect<A, IndexerError, RunPhase>,
              ): Effect.Effect<A, IndexerError> =>
                Effect.acquireUseRelease(
                  gate.withPermits(1)(
                    Effect.gen(function* () {
                      if ((yield* Ref.get(activeCalls)) === 0) {
                        yield* Ref.set(lockScope, yield* lock);
                        yield* Ref.set(phase, "backfill");
                      }

                      yield* Ref.update(activeCalls, (count) => count + 1);
                    }),
                  ),
                  () => effect,
                  (_, exit) =>
                    gate.withPermits(1)(
                      Effect.gen(function* () {
                        if ((yield* Ref.updateAndGet(activeCalls, (count) => count - 1)) > 0) {
                          return;
                        }

                        yield* Ref.set(
                          phase,
                          Exit.isSuccess(exit)
                            ? "done"
                            : Cause.hasInterruptsOnly(exit.cause)
                              ? "idle"
                              : "failed",
                        );

                        const scope = yield* Ref.getAndSet(lockScope, undefined);

                        if (scope !== undefined) {
                          yield* Scope.close(scope, Exit.void);
                        }
                      }),
                    ),
                ).pipe(
                  Effect.provideService(RunPhase, phase),
                  // Every metric recorded during the call carries the chain.
                  Effect.updateService(Metric.CurrentMetricAttributes, (attributes) => ({
                    ...attributes,
                    chain_id: String(config.chainId),
                  })),
                );

              return Indexer.of({
                run: trackRun(
                  runHistorical(options.contracts, config, sync).pipe(
                    Effect.provideService(StacksClient, client),
                    Effect.provideService(IndexerDatabase, database),
                  ),
                ),
                live: trackRun(
                  runLive(options.contracts, config, sync).pipe(
                    Effect.provideService(StacksClient, client),
                    Effect.provideService(IndexerDatabase, database),
                    Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
                  ),
                ),
                status: readIndexerStatus(config.chainId, options.contracts).pipe(
                  Effect.provideService(IndexerDatabase, database),
                  Effect.provideService(RunPhase, phase),
                ),
                reindex: (clearTables) =>
                  gate
                    .withPermits(1)(
                      Effect.gen(function* () {
                        if ((yield* Ref.get(activeCalls)) > 0) {
                          return yield* new LockError({
                            chainId: config.chainId,
                            message:
                              "Cannot reindex while `run` or `live` is running; stop it first.",
                          });
                        }

                        const scope = yield* lock;

                        yield* resetIndexing(
                          config.chainId,
                          options.contracts,
                          clearTables ?? Effect.void,
                        ).pipe(Effect.ensuring(Scope.close(scope, Exit.void)));
                      }),
                    )
                    .pipe(Effect.provideService(IndexerDatabase, database)),
              });
            }),
          ).pipe(
            Layer.provide(Sync.layer({ chainId: config.chainId })),
            Layer.provide(
              StacksClient.layer({ baseUrl: config.api.baseUrl, apiKey: config.api.apiKey }),
            ),
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
            Layer.provide(RunPhase.layer),
          ),
        ),
      ),
    );

  /**
   * Provides `Indexer`, `IndexerDatabase`, the pretty console logger and, when
   * `telemetry.otlp` is set, the OTLP metrics exporter. Opening the database
   * creates or upgrades the indexer's tables, then applies `migrations`.
   * Closing the layer flushes the exporter.
   */
  static readonly layerWithDatabase = (
    options: IndexerRuntimeOptions & {
      readonly relations?: AnyRelations;
      readonly contracts: readonly ContractSpec[];
    },
  ): Layer.Layer<Indexer | IndexerDatabase, ConfigurationError | DatabaseError | MigrationError> =>
    Indexer.layer({
      chain: options.chain,
      api: options.api,
      finality: options.finality,
      live: options.live,
      contracts: options.contracts,
    }).pipe(
      // Built after the database and released before it, after the indexer.
      Layer.provide(telemetryLayer(options.telemetry)),
      Layer.provideMerge(
        IndexerDatabase.layer(options.database, {
          relations: options.relations,
          migrations: options.migrations,
        }),
      ),
      Layer.provideMerge(loggerLayer({ level: options.logLevel })),
    );
}
