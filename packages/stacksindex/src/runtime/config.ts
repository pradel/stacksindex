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

export type ResolvedLiveConfig =
  | { transport: "polling"; pollingInterval: number }
  | { transport: "websocket"; pollingInterval: number; webSocketUrl: string };

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

type DecodedLiveOptions = NonNullable<(typeof IndexerOptionsSchema.Type)["live"]>;

/**
 * The websocket URL is only resolved for the websocket transport, so a polling
 * indexer never depends on it. A default derived from an unparseable
 * `api.baseUrl` fails as a `ConfigurationError`.
 */
function resolveLiveConfig(
  live: DecodedLiveOptions | undefined,
  baseUrl: string,
): Effect.Effect<ResolvedLiveConfig, ConfigurationError> {
  const pollingInterval = live?.pollingInterval ?? DEFAULT_POLLING_INTERVAL;

  if (live?.transport !== "websocket") {
    return Effect.succeed({ transport: "polling", pollingInterval });
  }

  if (live.webSocketUrl !== undefined) {
    return Effect.succeed({
      transport: "websocket",
      pollingInterval,
      webSocketUrl: live.webSocketUrl,
    });
  }

  return Effect.try({
    try: () => defaultWebSocketUrl(baseUrl),
    catch: () =>
      new ConfigurationError({
        message: `Cannot derive a websocket URL from api.baseUrl ${JSON.stringify(baseUrl)}; set live.webSocketUrl.`,
      }),
  }).pipe(
    Effect.map((webSocketUrl) => ({
      transport: "websocket" as const,
      pollingInterval,
      webSocketUrl,
    })),
  );
}

export function resolveIndexerConfig(
  options?: IndexerOptions,
): Effect.Effect<ResolvedIndexerConfig, ConfigurationError> {
  return Schema.decodeUnknownEffect(IndexerOptionsSchema)(options ?? {}).pipe(
    Effect.mapError((error) => new ConfigurationError({ message: error.message })),
    Effect.flatMap((decoded) => {
      const network = resolveNetwork(decoded.network);
      const baseUrl = decoded.api?.baseUrl ?? network.baseUrl;
      const api: ResolvedIndexerConfig["api"] = { baseUrl };

      if (decoded.api?.apiKey !== undefined) {
        api.apiKey = decoded.api.apiKey;
      }

      return resolveLiveConfig(decoded.live, baseUrl).pipe(
        Effect.map((live) => ({
          network,
          chainId: network.chainId,
          api,
          finality: decoded.finality ?? DEFAULT_FINALITY,
          live,
        })),
      );
    }),
  );
}
