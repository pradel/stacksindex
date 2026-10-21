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
  IndexerPhase,
  IndexerStatus,
  LiveOptions,
  OtlpOptions,
  RunResult,
  TelemetryOptions,
} from "./runtime/index.ts";

export { type DatabaseConfig, type IndexerDb } from "./database/index.ts";

export { ReadOnlyCallError } from "./datasources/api/index.ts";

export type {
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  StacksApiError,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "./datasources/api/index.ts";

export type {
  ClarityAbi,
  ClarityAbiAccess,
  ClarityAbiArg,
  ClarityAbiFunction,
  ContractFunctionParameters,
} from "clarity-abitype";

export {
  ConfigurationError,
  DatabaseError,
  FilterValidationError,
  HandlerExecutionError,
  InvalidCursorError,
  MigrationError,
  ReorgError,
  SyncStoreError,
  TransactionBatchError,
} from "./lib/errors.ts";

export {
  MAINNET_API_URL,
  MAINNET_CHAIN_ID,
  TESTNET_API_URL,
  TESTNET_CHAIN_ID,
  resolveChain,
} from "./lib/network.ts";

export type { ChainOption, ResolvedChain } from "./lib/network.ts";

export type { HandlerEvent } from "./lib/types.ts";
