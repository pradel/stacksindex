import type { AnyRelations } from "drizzle-orm";
import { Cause, Context, Effect, Exit, Layer, Metric, Ref } from "effect";
import { Socket } from "effect/socket";

import { IndexerDatabase } from "../database/index.ts";
import { StacksClient } from "../datasources/api/index.ts";
import type {
  ConfigurationError,
  DatabaseError,
  MigrationError,
  SyncStoreError,
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

              // Concurrent calls share the phase: only a call starting while none
              // Is active moves it to "backfill", and only the last call to end
              // Sets the outcome. `runLive` moves it to "live" once it follows new heads.
              const activeCalls = yield* Ref.make(0);

              const trackRun = <A>(
                effect: Effect.Effect<A, IndexerError, RunPhase>,
              ): Effect.Effect<A, IndexerError> =>
                Effect.acquireUseRelease(
                  Ref.getAndUpdate(activeCalls, (count) => count + 1).pipe(
                    Effect.flatMap((active) =>
                      active === 0 ? Ref.set(phase, "backfill") : Effect.void,
                    ),
                  ),
                  () => effect,
                  (_, exit) =>
                    Ref.updateAndGet(activeCalls, (count) => count - 1).pipe(
                      Effect.flatMap((active) =>
                        active === 0
                          ? Ref.set(
                              phase,
                              Exit.isSuccess(exit)
                                ? "done"
                                : Cause.hasInterruptsOnly(exit.cause)
                                  ? "idle"
                                  : "failed",
                            )
                          : Effect.void,
                      ),
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
