// oxlint-disable typescript/method-signature-style

import type { ClarityAbi } from "clarity-abitype";
import type { Effect } from "effect";

import type { ClarityJsonValue } from "../codec/index.ts";
import type { IndexerDatabase } from "../database/index.ts";
import type {
  ContractFunctionArgs,
  ContractFunctionName,
  StacksApiError,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "../datasources/api/index.ts";
import type { HandlerClient } from "../indexing/client.ts";

/** A `print` emitted by an indexed contract, with its decoded value. */
export interface PrintEvent<TData = ClarityJsonValue> {
  readonly type: "print";
  /** Definition name of the contract (the key in `contracts`). */
  readonly contract: string;
  readonly contractId: string;
  readonly txId: string;
  readonly eventIndex: number;
  /** The printed value, decoded from Clarity and parsed by the contract's `print` schema. */
  readonly data: TData;
  readonly raw: {
    readonly hex: string;
    readonly repr: string;
    readonly topic: string;
  };
  readonly block: {
    readonly height: number;
    /** Unix seconds. */
    readonly time: number;
    readonly hash: string;
    /** Pass as `tip` to read contract state at this block; `callReadOnly` defaults to it. */
    readonly indexBlockHash: string;
  };
  readonly tx: {
    readonly index: number;
    readonly sender: string;
  };
}

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
 * Handler as the runtime runs it: the facades adapt user handlers to this.
 * `IndexerDatabase` is the batch transaction and `HandlerClient` is pinned to
 * the event's block while it runs.
 */
export type CoreHandler = (
  event: PrintEvent<unknown>,
) => Effect.Effect<void, unknown, IndexerDatabase | HandlerClient>;
