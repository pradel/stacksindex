import { Effect, type LogLevel, Schema } from "effect";

import type { Database } from "../database/index.ts";
import { defaultWebSocketUrl, type HeadsTransport } from "../datasources/api/heads.ts";
import type { StacksApiError } from "../datasources/api/index.ts";
import {
  ConfigurationError,
  type DatabaseError,
  type EventDecodeError,
  type FilterValidationError,
  type HandlerExecutionError,
  type InvalidCursorError,
  type LockError,
  type ReorgError,
  type SyncStoreError,
  type TransactionBatchError,
} from "../lib/errors.ts";
import { type ChainOption, ChainOptionSchema, resolveChain } from "../lib/network.ts";
import type { TelemetryOptions } from "../telemetry/index.ts";

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

/** How the runtime reaches the chain and when it finalizes. */
export interface IndexerOptions {
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
  /** How `live` follows new blocks. */
  live?: LiveOptions;
}

/** Options of `create` (promise) and `layer` (Effect), apart from `handlers`. */
export interface IndexerRuntimeOptions extends IndexerOptions {
  /** Database for sync storage, checkpoints and your own tables: `pglite(...)` or `postgres(...)`. */
  database: Database;
  /**
   * Folder of your drizzle-kit migrations, applied when the database opens,
   * after the indexer's own. Tracked in drizzle's default `drizzle.__drizzle_migrations`.
   */
  migrations?: string;
  /** Minimum log level for the console logger. Defaults to `"Info"`. */
  logLevel?: LogLevel.LogLevel;
  /** Pushes metrics over OTLP. Unset: metrics are recorded but not exported. */
  telemetry?: TelemetryOptions;
}

export type ResolvedLiveConfig =
  | { transport: "polling"; pollingInterval: number }
  | { transport: "websocket"; pollingInterval: number; webSocketUrl: string };

export interface ResolvedIndexerConfig {
  chainId: number;
  api: { baseUrl: string; apiKey?: string };
  finality: number;
  live: ResolvedLiveConfig;
}

/** Every failure of `run` and `live`. */
export type IndexerError =
  | ConfigurationError
  | StacksApiError
  | HandlerExecutionError
  | EventDecodeError
  | ReorgError
  | FilterValidationError
  | SyncStoreError
  | TransactionBatchError
  | DatabaseError
  | InvalidCursorError
  | LockError;

const IndexerOptionsSchema = Schema.Struct({
  chain: Schema.optional(ChainOptionSchema),
  api: Schema.optional(
    Schema.Struct({
      url: Schema.optional(Schema.String),
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
 * indexer never depends on it. A default derived from an unparseable API URL
 * fails as a `ConfigurationError`.
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
        message: `Cannot derive a websocket URL from the API URL ${JSON.stringify(baseUrl)}; set live.webSocketUrl.`,
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
      const chain = resolveChain(decoded.chain);
      const baseUrl = decoded.api?.url ?? chain.apiUrl;
      const api: ResolvedIndexerConfig["api"] = { baseUrl };

      if (decoded.api?.apiKey !== undefined) {
        api.apiKey = decoded.api.apiKey;
      }

      return resolveLiveConfig(decoded.live, baseUrl).pipe(
        Effect.map((live) => ({
          chainId: chain.chainId,
          api,
          finality: decoded.finality ?? DEFAULT_FINALITY,
          live,
        })),
      );
    }),
  );
}
