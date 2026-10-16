import { Cause, Context, Effect, Exit, Layer, Metric, Ref } from "effect";
import { Socket } from "effect/socket";

import { IndexerDatabase } from "../database/index.ts";
import { StacksClient } from "../datasources/api/index.ts";
import type { ConfigurationError, DatabaseError, SyncStoreError } from "../lib/errors.ts";
import { loggerLayer } from "../logger/index.ts";
import { Sync } from "../sync/index.ts";
import { telemetryLayer } from "../telemetry/index.ts";
import {
  type IndexerError,
  type IndexerOptions,
  type IndexerWithDatabaseOptions,
  resolveIndexerConfig,
} from "./config.ts";
import type { Filter } from "./filters.ts";
import { runHistorical, type RunResult } from "./historical.ts";
import { runLive } from "./realtime.ts";
import { type IndexerStatus, readIndexerStatus, RunPhase } from "./status.ts";

export type {
  IndexerError,
  IndexerOptions,
  IndexerWithDatabaseOptions,
  LiveOptions,
} from "./config.ts";

export type { Filter } from "./filters.ts";

export type { ContractRunResult, RunResult } from "./historical.ts";

export type { IndexerPhase, IndexerStatus } from "./status.ts";

export type { OtlpOptions, TelemetryOptions } from "../telemetry/index.ts";

export interface IndexerService {
  /**
   * Syncs and indexes every filter up to the chain tip read at the start of the
   * call, then returns.
   */
  readonly run: (filters: Filter[]) => Effect.Effect<RunResult, IndexerError>;
  /**
   * Runs `run`, then follows new blocks and indexes them as they arrive. Ends
   * once every filter reached its `endBlock`; runs until interrupted when a
   * filter has none.
   */
  readonly live: (filters: Filter[]) => Effect.Effect<void, IndexerError>;
  /** Current phase plus the stored checkpoint, anchor and per-contract sync progress. */
  readonly status: Effect.Effect<IndexerStatus, SyncStoreError>;
}

export class Indexer extends Context.Service<Indexer, IndexerService>()(
  "stacksindex/runtime/Indexer",
) {
  static readonly layer = (
    options?: IndexerOptions,
  ): Layer.Layer<Indexer, ConfigurationError, IndexerDatabase> =>
    Layer.unwrap(
      resolveIndexerConfig(options).pipe(
        Effect.map((config) =>
          Layer.effect(
            Indexer,
            Effect.gen(function* () {
              const sync = yield* Sync;
              const client = yield* StacksClient;
              const database = yield* IndexerDatabase;
              const webSocketConstructor = yield* Socket.WebSocketConstructor;
              const phase = yield* RunPhase;

              // `runLive` moves the phase to "live" itself once it follows new heads.
              const trackRun = <A>(
                effect: Effect.Effect<A, IndexerError, RunPhase>,
              ): Effect.Effect<A, IndexerError> =>
                Ref.set(phase, "backfill").pipe(
                  Effect.andThen(effect),
                  Effect.onExit((exit) =>
                    Ref.set(
                      phase,
                      Exit.isSuccess(exit)
                        ? "done"
                        : Cause.hasInterruptsOnly(exit.cause)
                          ? "idle"
                          : "failed",
                    ),
                  ),
                  Effect.provideService(RunPhase, phase),
                  // Every metric recorded during the call carries the chain.
                  Effect.updateService(Metric.CurrentMetricAttributes, (attributes) => ({
                    ...attributes,
                    chain_id: String(config.chainId),
                  })),
                );

              return Indexer.of({
                run: (filters) =>
                  trackRun(
                    runHistorical(filters, config, sync).pipe(
                      Effect.provideService(StacksClient, client),
                      Effect.provideService(IndexerDatabase, database),
                    ),
                  ),
                live: (filters) =>
                  trackRun(
                    runLive(filters, config, sync).pipe(
                      Effect.provideService(StacksClient, client),
                      Effect.provideService(IndexerDatabase, database),
                      Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
                    ),
                  ),
                status: readIndexerStatus(config.chainId).pipe(
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
   * Batteries-included layer: provides `Indexer`, `IndexerDatabase`, the
   * pretty console logger and, when `telemetry.otlp` is set, the OTLP metrics
   * exporter from a single config. Closing the layer flushes the exporter.
   */
  static readonly layerWithDatabase = (
    options: IndexerWithDatabaseOptions,
  ): Layer.Layer<Indexer | IndexerDatabase, ConfigurationError | DatabaseError> =>
    Indexer.layer({
      network: options.network,
      api: options.api,
      finality: options.finality,
      live: options.live,
    }).pipe(
      // Built after the database and released before it, after the indexer.
      Layer.provide(telemetryLayer(options.telemetry)),
      Layer.provideMerge(IndexerDatabase.layer(options.database)),
      Layer.provideMerge(loggerLayer({ level: options.logLevel })),
    );
}
