import { Effect, type LogLevel, Schema } from "effect";

import type { DatabaseConfig } from "../database/index.ts";
import { defaultWebSocketUrl, type HeadsTransport } from "../datasources/api/heads.ts";
import type { StacksApiError } from "../datasources/api/index.ts";
import {
  ConfigurationError,
  type DatabaseError,
  type FilterValidationError,
  type HandlerExecutionError,
  type InvalidCursorError,
  type MigrationError,
  type ReorgError,
  type SyncStoreError,
  type TransactionBatchError,
} from "../lib/errors.ts";
import {
  NetworkOptionSchema,
  resolveNetwork,
  type NetworkOption,
  type ResolvedNetwork,
} from "../lib/network.ts";

/** Default number of blocks kept unfinalized behind the chain tip. */
export const DEFAULT_FINALITY = 6;

/**
 * Default milliseconds between polls for a new chain head. Stacks blocks
 * arrive every ~10s; 5s keeps head polling at 12 requests per minute, well
 * inside the unauthenticated Hiro budget of 50.
 */
export const DEFAULT_POLLING_INTERVAL = 5000;

/** Lowest accepted polling interval, in milliseconds. */
const MIN_POLLING_INTERVAL = 100;

export interface LiveOptions {
  /**
   * How new chain heads are detected: `"polling"` (default) asks the API for
   * the latest block every `pollingInterval`; `"websocket"` subscribes to new
   * blocks and falls back to polling after repeated connection failures.
   */
  transport?: HeadsTransport;
  /** Milliseconds between head polls. Defaults to `5000`, minimum `100`. */
  pollingInterval?: number;
  /** Websocket endpoint. Defaults to `/extended/v1/ws` on the API base URL. */
  webSocketUrl?: string;
}

export interface IndexerOptions {
  /** Which chain to index. Defaults to `"mainnet"`. */
  network?: NetworkOption;
  api?: {
    /** Overrides the network's default API endpoint. */
    baseUrl?: string;
    apiKey?: string;
  };
  /**
   * Number of blocks kept unfinalized behind the chain tip. Reorgs within this
   * depth are replayed; a reorg that replaces a finalized block fails with
   * `ReorgError`. Defaults to `6`.
   */
  finality?: number;
  /** How `live` follows new blocks. */
  live?: LiveOptions;
}

export interface IndexerWithDatabaseOptions extends IndexerOptions {
  /** Database used for sync storage and checkpoints. */
  database: DatabaseConfig;
  /** Minimum log level for the pretty console logger. Defaults to `"Info"`. */
  logLevel?: LogLevel.LogLevel;
}

export interface ResolvedLiveConfig {
  transport: HeadsTransport;
  pollingInterval: number;
  webSocketUrl: string;
}

export interface ResolvedIndexerConfig {
  chainId: number;
  api: { baseUrl: string; apiKey?: string };
  network: ResolvedNetwork;
  finality: number;
  live: ResolvedLiveConfig;
}

export type IndexerError =
  | StacksApiError
  | HandlerExecutionError
  | ReorgError
  | FilterValidationError
  | SyncStoreError
  | TransactionBatchError
  | DatabaseError
  | MigrationError
  | InvalidCursorError;

const IndexerOptionsSchema = Schema.Struct({
  network: Schema.optional(NetworkOptionSchema),
  api: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.optional(Schema.String),
      apiKey: Schema.optional(Schema.String),
    }),
  ),
  finality: Schema.optional(Schema.Natural),
  live: Schema.optional(
    Schema.Struct({
      transport: Schema.optional(Schema.Literals(["polling", "websocket"])),
      pollingInterval: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_POLLING_INTERVAL)),
      ),
      webSocketUrl: Schema.optional(Schema.String),
    }),
  ),
});

export function resolveIndexerConfig(
  options?: IndexerOptions,
): Effect.Effect<ResolvedIndexerConfig, ConfigurationError> {
  return Schema.decodeUnknownEffect(IndexerOptionsSchema)(options ?? {}).pipe(
    Effect.mapError((error) => new ConfigurationError({ message: error.message })),
    Effect.map((decoded) => {
      const network = resolveNetwork(decoded.network);
      const baseUrl = decoded.api?.baseUrl ?? network.baseUrl;
      const api: ResolvedIndexerConfig["api"] = { baseUrl };

      if (decoded.api?.apiKey !== undefined) {
        api.apiKey = decoded.api.apiKey;
      }

      return {
        network,
        chainId: network.chainId,
        api,
        finality: decoded.finality ?? DEFAULT_FINALITY,
        live: {
          transport: decoded.live?.transport ?? "polling",
          pollingInterval: decoded.live?.pollingInterval ?? DEFAULT_POLLING_INTERVAL,
          webSocketUrl: decoded.live?.webSocketUrl ?? defaultWebSocketUrl(baseUrl),
        },
      };
    }),
  );
}
