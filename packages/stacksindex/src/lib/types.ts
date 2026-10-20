// oxlint-disable typescript/method-signature-style

import type { ClarityAbi } from "clarity-abitype";
import type { AnyRelations } from "drizzle-orm";
import type { Effect, Schema } from "effect";

import type { ClarityJsonValue } from "../codec/index.ts";
import type { IndexerDb } from "../database/index.ts";
import type {
  ContractFunctionArgs,
  ContractFunctionName,
  SmartContractLogEvent,
  StacksApiError,
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
  /** Index block hash of the event's block: pass it as `tip` to read contract state at this block. */
  index_block_hash: string;
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
  ): Effect.Effect<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError>;

  callReadOnly(
    options: UntypedCallReadOnlyFunctionParameters,
  ): Effect.Effect<ClarityJsonValue, StacksApiError>;
}

/**
 * Context passed to a handler. `TRelations` types `db.query`: use the
 * `relations` the database was opened with (`typeof relations`).
 */
export interface HandlerContext<TRelations extends AnyRelations = AnyRelations> {
  /**
   * Indexer database scoped to the batch transaction: writes commit together
   * with the indexing checkpoint, or roll back with it.
   */
  db: IndexerDb<TRelations>;
  client: IndexingClient;
  decode: <A>(schema: Schema.Schema<A>, repr: string) => Effect.Effect<A, unknown>;
}

export type EventHandler<TRelations extends AnyRelations = AnyRelations> = (
  event: HandlerEvent,
  context: HandlerContext<TRelations>,
) => Effect.Effect<void, any>;

export type Handlers = Record<string, EventHandler | undefined>;
