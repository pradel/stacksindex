// Promise-native entrypoint (`stacksindex`).

export { createIndexer } from "./promise/index.ts";

export type {
  EventHandler,
  Filter,
  HandlerContext,
  Indexer,
  IndexerOptions,
  IndexingClient,
  LogAnnotations,
  Logger,
  LogLevel,
  LogValue,
} from "./promise/index.ts";

export type {
  ContractRunResult,
  IndexerError,
  IndexerPhase,
  IndexerStatus,
  LiveOptions,
  OtlpOptions,
  RunResult,
  TelemetryOptions,
} from "./runtime/index.ts";

export { pglite, postgres } from "./database/index.ts";

export type { Database, IndexerDb } from "./database/index.ts";

export type { ChainOption } from "./lib/network.ts";

export type { HandlerEvent } from "./lib/types.ts";

export {
  ConfigurationError,
  DatabaseError,
  HandlerExecutionError,
  MigrationError,
  ReorgError,
} from "./lib/errors.ts";

export { ReadOnlyCallError } from "./datasources/api/index.ts";

export type { StacksApiError } from "./datasources/api/index.ts";

export type { ClarityAbi } from "clarity-abitype";
