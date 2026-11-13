// Promise-native entrypoint (`stacksindex`).

export { defineIndexer } from "./promise/index.ts";

export type {
  ContractDefinition,
  ContractDefinitions,
  CreateOptions,
  EventHandler,
  HandlerContext,
  Handlers,
  Indexer,
  IndexerDefinition,
  IndexingClient,
  LogAnnotations,
  Logger,
  LogValue,
  PrintData,
} from "./promise/index.ts";

export { pglite, postgres } from "./database/index.ts";

export type { Database, IndexerDb } from "./database/index.ts";

export type { PrintEvent } from "./lib/types.ts";

export type { ChainOption } from "./lib/network.ts";

export type { OnInvalid } from "./runtime/contracts.ts";

export type {
  ContractRunResult,
  ContractStatus,
  IndexerError,
  IndexerPhase,
  IndexerRuntimeOptions,
  IndexerStatus,
  LiveOptions,
  OtlpOptions,
  RunResult,
  TelemetryOptions,
} from "./runtime/index.ts";

export {
  ConfigurationError,
  DatabaseError,
  EventDecodeError,
  HandlerExecutionError,
  LockError,
  MigrationError,
  ReorgError,
} from "./lib/errors.ts";

export { ReadOnlyCallError } from "./datasources/api/index.ts";

export type { StacksApiError } from "./datasources/api/index.ts";

export type { ClarityAbi } from "clarity-abitype";
