// Promise-native entrypoint (`stacksindex`).

export { createHistoricalRuntime } from "./promise/index.ts";

export type {
  EventHandler,
  Filter,
  HandlerContext,
  HistoricalRuntime,
  HistoricalRuntimeOptions,
  IndexingClient,
  LogAnnotations,
  Logger,
  LogLevel,
  LogValue,
} from "./promise/index.ts";

export type { ContractRunResult, RunResult } from "./runtime/historical.ts";

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
  FilterValidationError,
  HandlerExecutionError,
  SyncStoreError,
  TransactionBatchError,
} from "./lib/errors.ts";

export {
  MAINNET_API_BASE_URL,
  MAINNET_CHAIN_ID,
  TESTNET_API_BASE_URL,
  TESTNET_CHAIN_ID,
  resolveNetwork,
} from "./lib/network.ts";

export type { NetworkName, NetworkOption, ResolvedNetwork } from "./lib/network.ts";

export {
  ClarityTypeID,
  cvToJSON,
  decodeClarityValue,
  decodeHex,
  encodeUint,
} from "./codec/index.ts";

export type { ClarityJsonValue, ClarityValue } from "./codec/index.ts";

export type { HandlerEvent } from "./lib/types.ts";
