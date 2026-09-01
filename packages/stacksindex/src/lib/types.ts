// oxlint-disable typescript/method-signature-style

import type { Result } from "better-result";
import type { ClarityAbi } from "clarity-abitype";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { StacksApiError } from "../datasources/api/errors.ts";
import type {
  CallReadResponse,
  ContractFunctionArgs,
  ContractFunctionName,
  SmartContractLogEvent,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "../datasources/api/index.ts";

export interface LogEvent {
  type: "log";
}

export type Event = LogEvent;

export type HandlerEvent = SmartContractLogEvent & {
  block_height: number;
  block_time: number;
  tx_index: number;
  sender_address: string;
};

export interface IndexingClient {
  callReadOnly<
    const TAbi extends ClarityAbi | readonly unknown[],
    TFunctionName extends ContractFunctionName<TAbi, "read_only">,
    const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
  >(
    options: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>,
  ): Promise<Result<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError>>;

  callReadOnly(
    options: UntypedCallReadOnlyFunctionParameters,
  ): Promise<Result<CallReadResponse, StacksApiError>>;
}

// oxlint-disable-next-line typescript/no-explicit-any
export interface HandlerContext<TSchema extends Record<string, unknown> = any> {
  db: NodePgDatabase<TSchema> | PgliteDatabase<TSchema>;
  client: IndexingClient;
}

export type EventHandler = (event: HandlerEvent, context: HandlerContext) => Promise<void>;

export type Handlers = Record<string, EventHandler | undefined>;
