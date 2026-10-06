// Effect-native entrypoint (`stacksindex/effect`).

export { loggerLayer } from "./logger/index.ts";

export type { LoggerLayerOptions } from "./logger/index.ts";

export { getMigrationsFolder, IndexerDatabase, makeDatabase, migrate } from "./database/index.ts";

export type { DatabaseConfig, IndexerDb } from "./database/index.ts";

export { HistoricalRuntime } from "./runtime/historical.ts";

export type {
  ContractRunResult,
  Filter,
  HistoricalRuntimeError,
  HistoricalRuntimeOptions,
  HistoricalRuntimeService,
  HistoricalRuntimeWithDatabaseOptions,
  RunResult,
} from "./runtime/historical.ts";

export {
  MAINNET_API_BASE_URL,
  MAINNET_CHAIN_ID,
  TESTNET_API_BASE_URL,
  TESTNET_CHAIN_ID,
  resolveNetwork,
} from "./lib/network.ts";

export type { NetworkName, NetworkOption, ResolvedNetwork } from "./lib/network.ts";

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
  SyncStoreError,
  TransactionBatchError,
} from "./lib/errors.ts";

export {
  ClarityTypeID,
  cvToJSON,
  decodeClarityValue,
  decodeClarityWithSchema,
  decodeHex,
  encodeUint,
} from "./codec/index.ts";

export type { ClarityJsonValue, ClarityValue } from "./codec/index.ts";

export type {
  EventHandler,
  HandlerContext,
  HandlerEvent,
  Handlers,
  IndexingClient,
} from "./lib/types.ts";
