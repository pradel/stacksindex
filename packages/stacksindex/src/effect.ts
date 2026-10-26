// Effect-native entrypoint (`stacksindex/effect`).

export { defineIndexer } from "./effect-api/index.ts";

export type {
  BlockHandler,
  ContractDefinition,
  ContractDefinitions,
  EmptyDefinitions,
  EventHandler,
  HandlerRequirements,
  Handlers,
  IndexerDefinition,
  LayerOptions,
  PrintData,
  SourceHandler,
} from "./effect-api/index.ts";

export { Indexer } from "./runtime/index.ts";

export type {
  BlockSourceRunResult,
  BlockSourceStatus,
  ContractRunResult,
  ContractStatus,
  IndexerError,
  IndexerPhase,
  IndexerRuntimeOptions,
  IndexerService,
  IndexerStatus,
  LiveOptions,
  OtlpOptions,
  RunResult,
  TelemetryOptions,
} from "./runtime/index.ts";

export { pglite, postgres } from "./database/index.ts";

export type { Database, IndexerDatabase, IndexerDb } from "./database/index.ts";

export type { HandlerClient } from "./indexing/client.ts";

export type { BlockEvent, EventBlock, IndexingClient, PrintEvent } from "./lib/types.ts";

export type { ChainOption } from "./lib/network.ts";

export type { OnInvalid } from "./runtime/contracts.ts";

export type { BlockDefinition, BlockDefinitions } from "./runtime/blocks.ts";

export {
  ConfigurationError,
  DatabaseError,
  EventDecodeError,
  HandlerExecutionError,
  MigrationError,
  ReorgError,
} from "./lib/errors.ts";

export { ReadOnlyCallError } from "./datasources/api/index.ts";

export type { StacksApiError } from "./datasources/api/index.ts";

export type { ClarityAbi } from "clarity-abitype";
