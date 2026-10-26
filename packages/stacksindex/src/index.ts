// Promise-native entrypoint (`stacksindex`).

export { defineIndexer } from "./promise/index.ts";

export type {
  BlockHandler,
  ContractDefinition,
  ContractDefinitions,
  CreateOptions,
  EmptyDefinitions,
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
  SourceHandler,
} from "./promise/index.ts";

export { pglite, postgres } from "./database/index.ts";

export type { Database, IndexerDb } from "./database/index.ts";

export type { BlockEvent, EventBlock, PrintEvent } from "./lib/types.ts";

export type { ChainOption } from "./lib/network.ts";

export type { OnInvalid } from "./runtime/contracts.ts";

export type { BlockDefinition, BlockDefinitions } from "./runtime/blocks.ts";

export type {
  BlockSourceRunResult,
  BlockSourceStatus,
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
  BlockHandlerExecutionError,
  HandlerExecutionError,
  MigrationError,
  ReorgError,
} from "./lib/errors.ts";

export { ReadOnlyCallError } from "./datasources/api/index.ts";

export type { StacksApiError } from "./datasources/api/index.ts";

export type { ClarityAbi } from "clarity-abitype";
