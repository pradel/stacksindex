import { Context, Effect, Layer } from "effect";
import { Socket } from "effect/socket";

import { IndexerDatabase } from "../database/index.ts";
import { StacksClient } from "../datasources/api/index.ts";
import type { ConfigurationError, DatabaseError } from "../lib/errors.ts";
import { loggerLayer } from "../logger/index.ts";
import { Sync } from "../sync/index.ts";
import {
  type IndexerError,
  type IndexerOptions,
  type IndexerWithDatabaseOptions,
  resolveIndexerConfig,
} from "./config.ts";
import type { Filter } from "./filters.ts";
import { runHistorical, type RunResult } from "./historical.ts";
import { runLive } from "./realtime.ts";

export type {
  IndexerError,
  IndexerOptions,
  IndexerWithDatabaseOptions,
  LiveOptions,
} from "./config.ts";

export type { Filter } from "./filters.ts";

export type { ContractRunResult, RunResult } from "./historical.ts";

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

              return Indexer.of({
                run: (filters) =>
                  runHistorical(filters, config, sync).pipe(
                    Effect.provideService(StacksClient, client),
                    Effect.provideService(IndexerDatabase, database),
                  ),
                live: (filters) =>
                  runLive(filters, config, sync).pipe(
                    Effect.provideService(StacksClient, client),
                    Effect.provideService(IndexerDatabase, database),
                    Effect.provideService(Socket.WebSocketConstructor, webSocketConstructor),
                  ),
              });
            }),
          ).pipe(
            Layer.provide(Sync.layer({ chainId: config.chainId })),
            Layer.provide(
              StacksClient.layer({ baseUrl: config.api.baseUrl, apiKey: config.api.apiKey }),
            ),
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
        ),
      ),
    );

  /**
   * Batteries-included layer: provides `Indexer`, `IndexerDatabase` and the
   * pretty console logger from a single config.
   */
  static readonly layerWithDatabase = (
    options: IndexerWithDatabaseOptions,
  ): Layer.Layer<Indexer | IndexerDatabase, ConfigurationError | DatabaseError> =>
    Layer.mergeAll(
      Indexer.layer({
        network: options.network,
        api: options.api,
        finality: options.finality,
        live: options.live,
      }).pipe(Layer.provideMerge(IndexerDatabase.layer(options.database))),
      loggerLayer({ level: options.logLevel }),
    );
}
