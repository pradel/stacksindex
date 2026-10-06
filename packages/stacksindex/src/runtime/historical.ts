import { Context, Effect, Layer, Match, Schema, Stream, type LogLevel } from "effect";

import { type DatabaseConfig, IndexerDatabase, migrate } from "../database/index.ts";
import { type StacksApiError, StacksClient } from "../datasources/api/index.ts";
import { Indexing } from "../indexing/index.ts";
import {
  ConfigurationError,
  type DatabaseError,
  type FilterValidationError,
  type HandlerExecutionError,
  type InvalidCursorError,
  type MigrationError,
  type SyncStoreError,
  type TransactionBatchError,
} from "../lib/errors.ts";
import {
  NetworkOptionSchema,
  resolveNetwork,
  type NetworkOption,
  type ResolvedNetwork,
} from "../lib/network.ts";
import type { EventHandler, HandlerEvent } from "../lib/types.ts";
import { loggerLayer } from "../logger/index.ts";
import { type StoredEvent, storedEventToHandlerEvent } from "../sync-store/decode.ts";
import { syncStore } from "../sync-store/index.ts";
import {
  type ContractSyncSummary,
  Sync,
  type SyncFilter,
  type SyncService,
} from "../sync/index.ts";
import { chunkEventsByBlock } from "./batches.ts";
import { type Filter, type ResolvedFilter, validateAndResolveFilters } from "./filters.ts";

export type { Filter } from "./filters.ts";

export interface HistoricalRuntimeOptions {
  /** Which chain to index. Defaults to `"mainnet"`. */
  network?: NetworkOption;
  api?: {
    /** Overrides the network's default API endpoint. */
    baseUrl?: string;
    apiKey?: string;
  };
}

export interface HistoricalRuntimeWithDatabaseOptions extends HistoricalRuntimeOptions {
  /** Database used for sync storage and checkpoints. */
  database: DatabaseConfig;
  /** Minimum log level for the pretty console logger. Defaults to `"Info"`. */
  logLevel?: LogLevel.LogLevel;
}

/**
 * Outcome of a single contract sync within a `run`.
 *
 * - `"completed"`: the contract was synced during this run.
 * - `"up-to-date"`: the contract was already fully synced and nothing was fetched.
 */
export interface ContractRunResult {
  contractId: string;
  status: "completed" | "up-to-date";
  startBlock?: number;
  endBlock?: number;
  /** Highest block height fully processed for this contract. */
  lastBlockHeight?: number;
  /** Number of events passed to the contract handler during this run. */
  eventsProcessed: number;
}

export interface RunResult {
  contracts: ContractRunResult[];
  /** Total number of events passed to handlers during this run. */
  eventsProcessed: number;
}

interface ResolvedHistoricalRuntimeConfig {
  chainId: number;
  api: { baseUrl: string; apiKey?: string };
  network: ResolvedNetwork;
}

const HistoricalRuntimeOptionsSchema = Schema.Struct({
  network: Schema.optional(NetworkOptionSchema),
  api: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.optional(Schema.String),
      apiKey: Schema.optional(Schema.String),
    }),
  ),
});

function resolveRuntimeConfig(
  options?: HistoricalRuntimeOptions,
): Effect.Effect<ResolvedHistoricalRuntimeConfig, ConfigurationError> {
  return Schema.decodeUnknownEffect(HistoricalRuntimeOptionsSchema)(options ?? {}).pipe(
    Effect.mapError((error) => new ConfigurationError({ message: error.message })),
    Effect.map((decoded) => {
      const network = resolveNetwork(decoded.network);
      const baseUrl = decoded.api?.baseUrl ?? network.baseUrl;
      const api: ResolvedHistoricalRuntimeConfig["api"] = { baseUrl };

      if (decoded.api?.apiKey !== undefined) {
        api.apiKey = decoded.api.apiKey;
      }

      return {
        network,
        chainId: network.chainId,
        api,
      };
    }),
  );
}

/**
 * Indexes one block-aligned batch of stored events together with the new
 * checkpoint, in a single transaction.
 */
function indexBatch(
  batch: StoredEvent[],
  filterMap: Map<string, ResolvedFilter>,
  chainId: number,
  eventsByContract: Map<string, number>,
): Effect.Effect<
  void,
  HandlerExecutionError | SyncStoreError | DatabaseError,
  Indexing | IndexerDatabase
> {
  return IndexerDatabase.transaction(() =>
    Effect.gen(function* () {
      const indexing = yield* Indexing;
      const events: HandlerEvent[] = [];

      for (const row of batch) {
        const filter = filterMap.get(row.contractId);
        const rowBlockHeight = Number(row.blockHeight);

        const isBeforeStart =
          filter?.startBlock !== undefined && rowBlockHeight < filter.startBlock;

        const isAfterEnd = filter?.endBlock !== undefined && rowBlockHeight > filter.endBlock;

        if (!isBeforeStart && !isAfterEnd) {
          events.push(storedEventToHandlerEvent(row));
          eventsByContract.set(row.contractId, (eventsByContract.get(row.contractId) ?? 0) + 1);
        }
      }

      yield* indexing.executeBatch(events);

      const lastRow = batch[batch.length - 1];
      yield* syncStore.upsertCheckpoint({
        chainId,
        blockHeight: Number(lastRow.blockHeight),
        blockTime: Number(lastRow.blockTime),
      });
    }),
  );
}

/**
 * Indexes every stored event with height `> checkpoint` and `<= toBlockHeight`.
 * Events are split into block-aligned batches so each transaction stays
 * bounded and every checkpoint refers to a fully processed block.
 */
function indexEventsUpTo(
  toBlockHeight: number,
  filterMap: Map<string, ResolvedFilter>,
  chainId: number,
  eventsByContract: Map<string, number>,
): Effect.Effect<
  void,
  HandlerExecutionError | SyncStoreError | DatabaseError,
  Indexing | IndexerDatabase
> {
  return Effect.gen(function* () {
    const checkpoint = yield* syncStore.getCheckpoint({ chainId });
    const fromBlockHeight = checkpoint ? Number(checkpoint.blockHeight) : 0;

    if (fromBlockHeight >= toBlockHeight) {
      return;
    }

    const rows = yield* syncStore.getEvents({
      chainId,
      fromBlockHeight: fromBlockHeight + 1,
      toBlockHeight,
    });

    if (rows.length === 0) {
      return;
    }

    const batches = chunkEventsByBlock(rows);
    const toLabel = toBlockHeight === Number.MAX_SAFE_INTEGER ? "latest" : String(toBlockHeight);

    yield* Effect.logInfo(`Indexing events from block ${fromBlockHeight + 1} to ${toLabel}`).pipe(
      Effect.annotateLogs({ count: rows.length, batches: batches.length }),
    );

    for (const batch of batches) {
      yield* indexBatch(batch, filterMap, chainId, eventsByContract);
    }

    const lastRow = rows[rows.length - 1];
    yield* Effect.logInfo(
      `Indexed ${rows.length} events up to block ${Number(lastRow.blockHeight)}`,
    ).pipe(Effect.annotateLogs({ block: Number(lastRow.blockHeight) }));
  });
}

export type HistoricalRuntimeError =
  | StacksApiError
  | HandlerExecutionError
  | FilterValidationError
  | SyncStoreError
  | TransactionBatchError
  | DatabaseError
  | MigrationError
  | InvalidCursorError;

export interface HistoricalRuntimeService {
  readonly run: (filters: Filter[]) => Effect.Effect<RunResult, HistoricalRuntimeError>;
}

export class HistoricalRuntime extends Context.Service<
  HistoricalRuntime,
  HistoricalRuntimeService
>()("stacksindex/runtime/HistoricalRuntime") {
  static readonly layer = (
    options?: HistoricalRuntimeOptions,
  ): Layer.Layer<HistoricalRuntime, ConfigurationError, IndexerDatabase> =>
    Layer.unwrap(
      resolveRuntimeConfig(options).pipe(
        Effect.map((config) =>
          Layer.effect(
            HistoricalRuntime,
            Effect.gen(function* () {
              const sync = yield* Sync;
              const client = yield* StacksClient;
              const database = yield* IndexerDatabase;

              return HistoricalRuntime.of({
                run: (filters) =>
                  runHistorical(filters, config, sync).pipe(
                    Effect.provideService(StacksClient, client),
                    Effect.provideService(IndexerDatabase, database),
                  ),
              });
            }),
          ).pipe(
            Layer.provide(Sync.layer({ chainId: config.chainId })),
            Layer.provide(
              StacksClient.layer({ baseUrl: config.api.baseUrl, apiKey: config.api.apiKey }),
            ),
          ),
        ),
      ),
    );

  /**
   * Batteries-included layer: provides `HistoricalRuntime`, `IndexerDatabase`
   * and the pretty console logger from a single config.
   */
  static readonly layerWithDatabase = (
    options: HistoricalRuntimeWithDatabaseOptions,
  ): Layer.Layer<HistoricalRuntime | IndexerDatabase, ConfigurationError | DatabaseError> =>
    Layer.mergeAll(
      HistoricalRuntime.layer({ network: options.network, api: options.api }).pipe(
        Layer.provideMerge(IndexerDatabase.layer(options.database)),
      ),
      loggerLayer({ level: options.logLevel }),
    );
}

function runHistorical(
  filters: Filter[],
  config: ResolvedHistoricalRuntimeConfig,
  sync: SyncService,
): Effect.Effect<RunResult, HistoricalRuntimeError, StacksClient | IndexerDatabase> {
  const { chainId } = config;

  const effect = Effect.gen(function* run() {
    if (filters.length === 0) {
      return { contracts: [], eventsProcessed: 0 };
    }

    const resolvedFilters = yield* validateAndResolveFilters(filters);

    yield* migrate();

    yield* Effect.logInfo("Starting historical indexing").pipe(
      Effect.annotateLogs({ contracts: resolvedFilters.map((filter) => filter.contractId) }),
    );

    const filterMap = new Map(resolvedFilters.map((filter) => [filter.contractId, filter]));
    const handlers: Record<string, EventHandler | undefined> = {};

    for (const filter of resolvedFilters) {
      handlers[filter.contractId] = filter.handler;
    }

    const syncFilters: SyncFilter[] = resolvedFilters.map((filter) => ({
      contractId: filter.contractId,
      startBlock: filter.startBlock,
      endBlock: filter.endBlock,
    }));

    const eventsByContract = new Map<string, number>();

    let startedContracts: readonly ContractSyncSummary[] = [];
    let completedContracts: readonly ContractSyncSummary[] = [];

    const indexSafeHeight = (safeBlockHeight: number) =>
      indexEventsUpTo(safeBlockHeight, filterMap, chainId, eventsByContract);

    yield* Effect.gen(function* consumeSyncEvents() {
      yield* sync.historical(syncFilters).pipe(
        Stream.runForEach((event) =>
          Match.value(event).pipe(
            Match.when({ type: "started" }, (started) =>
              Effect.sync(() => {
                startedContracts = started.contracts;
              }),
            ),
            Match.when({ type: "safe" }, (safe) => indexSafeHeight(safe.safeBlockHeight)),
            Match.when({ type: "completed" }, (completed) =>
              Effect.sync(() => {
                completedContracts = completed.contracts;
              }),
            ),
            Match.exhaustive,
          ),
        ),
      );

      // Final pass: index any remaining stored events (e.g. events from a
      // Contract that finished after the last safe height was emitted).
      yield* indexSafeHeight(Number.MAX_SAFE_INTEGER);
    }).pipe(Effect.provide(Indexing.layer({ handlers })));

    yield* Effect.logInfo("Historical indexing complete");

    const finalContracts = completedContracts.length > 0 ? completedContracts : startedContracts;
    let eventsProcessed = 0;

    const contracts: ContractRunResult[] = finalContracts.map((contract) => {
      const contractEvents = eventsByContract.get(contract.contractId) ?? 0;
      eventsProcessed += contractEvents;

      return {
        contractId: contract.contractId,
        status: contract.doneAtStart ? "up-to-date" : "completed",
        startBlock: contract.startBlock,
        endBlock: contract.endBlock,
        lastBlockHeight: contract.lastBlockHeight,
        eventsProcessed: contractEvents,
      };
    });

    return { contracts, eventsProcessed };
  }).pipe(
    Effect.annotateLogs({ service: "historicalRuntime" }),
    Effect.withLogSpan("historicalIndexing"),
  );

  return effect;
}
