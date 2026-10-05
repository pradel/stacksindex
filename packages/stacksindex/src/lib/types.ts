// oxlint-disable typescript/method-signature-style

import type { ClarityAbi } from "clarity-abitype";
import type { Effect, Schema } from "effect";

import type { IndexerDb } from "../database/index.ts";
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
  ): Effect.Effect<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError> &
    PromiseLike<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>>;

  callReadOnly(
    options: UntypedCallReadOnlyFunctionParameters,
  ): Effect.Effect<CallReadResponse, StacksApiError> & PromiseLike<CallReadResponse>;
}

// oxlint-disable-next-line typescript/no-explicit-any
export interface HandlerContext<_TSchema extends Record<string, unknown> = any> {
  db: IndexerDb;
  client: IndexingClient;
  decode: <A>(schema: Schema.Schema<A>, repr: string) => Effect.Effect<A, unknown>;
}

export type EventHandler = (
  event: HandlerEvent,
  context: HandlerContext,
) => Effect.Effect<void, any> | Promise<void>;

export type Handlers = Record<string, EventHandler | undefined>;
