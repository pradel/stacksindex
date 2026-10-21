// Effect-native entrypoint (`stacksindex/effect`).

export { loggerLayer } from "./logger/index.ts";

export type { LoggerLayerOptions } from "./logger/index.ts";

export { IndexerDatabase, pglite, postgres } from "./database/index.ts";

export type { Database, DatabaseOptions, IndexerDb } from "./database/index.ts";

export { Indexer } from "./runtime/index.ts";

export type {
  ContractRunResult,
  Filter,
  IndexerError,
  IndexerOptions,
  IndexerPhase,
  IndexerService,
  IndexerStatus,
  IndexerWithDatabaseOptions,
  LiveOptions,
  OtlpOptions,
  RunResult,
  TelemetryOptions,
} from "./runtime/index.ts";

export {
  MAINNET_API_URL,
  MAINNET_CHAIN_ID,
  TESTNET_API_URL,
  TESTNET_CHAIN_ID,
  resolveChain,
} from "./lib/network.ts";

export type { ChainOption, ResolvedChain } from "./lib/network.ts";

export { readOnly, ReadOnlyCallError, StacksClient } from "./datasources/api/index.ts";

export type {
  CallReadFunction,
  CallReadResponse,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  StacksApiError,
  StacksClientConfig,
  StacksClientService,
  StacksHttpError,
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

export type {
  EventHandler,
  HandlerContext,
  HandlerEvent,
  Handlers,
  IndexingClient,
} from "./lib/types.ts";
