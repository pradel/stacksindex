import { cvToHex } from "@stacks/transactions";
import type {
  ClarityAbi,
  ClarityAbiFunction,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  UnionEvaluate,
  UnionWiden,
} from "clarity-abitype";
import { primitivesToCVs } from "clarity-abitype/stacks-js";
import { Effect, Schema } from "effect";
import type { HttpClientError } from "effect/http";
import type { RateLimiter } from "effect/persistence";

import { type ClarityJsonValue, decodeHex } from "../../codec/index.ts";
import type { StacksClientService } from "./index.ts";

export type { ContractFunctionArgs, ContractFunctionName, ContractFunctionReturnType };

/**
 * Domain failure raised when a read-only contract call returns a Clarity
 * error response or its result cannot be decoded.
 */
export class ReadOnlyCallError extends Schema.TaggedError<ReadOnlyCallError>()(
  "ReadOnlyCallError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type StacksHttpError = HttpClientError.HttpClientError | RateLimiter.RateLimiterError;

export type StacksApiError = StacksHttpError | ReadOnlyCallError;

/**
 * Parameters for calling a read-only function without ABI (raw hex arguments).
 */
export interface UntypedCallReadOnlyFunctionParameters {
  /** Fully qualified contract identifier (e.g. `SP3K8...my-token`). */
  contractId: string;
  /** The function name to call */
  functionName: string;
  /** Hex-encoded Clarity values as arguments */
  args?: string[];
  /** The sender address for the simulated call */
  senderAddress?: string;
  /** Block height tip to pin the read-only execution */
  tip?: number;
}

/**
 * Parameters for calling a read-only function with type safety.
 */
export type TypedCallReadOnlyFunctionParameters<
  TAbi extends ClarityAbi | readonly unknown[] = ClarityAbi,
  TFunctionName extends ContractFunctionName<TAbi, "read_only"> = ContractFunctionName<
    TAbi,
    "read_only"
  >,
  TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName> = ContractFunctionArgs<
    TAbi,
    "read_only",
    TFunctionName
  >,
> = UnionEvaluate<
  {
    /** The contract ABI */
    abi: TAbi;
    /** Fully qualified contract identifier (e.g. `SP3K8...my-token`). */
    contractId: string;
    /** The function name to call */
    functionName:
      | ContractFunctionName<TAbi, "read_only">
      | (TFunctionName extends ContractFunctionName<TAbi, "read_only"> ? TFunctionName : never);
    /** The sender address for the simulated call */
    senderAddress?: string;
    /** Block height tip to pin the read-only execution */
    tip?: number;
  } & (readonly [] extends TArgs
    ? {
        /** Function arguments (optional when function takes no arguments) */
        functionArgs?: UnionWiden<TArgs> | undefined;
      }
    : {
        /** Function arguments */
        functionArgs: UnionWiden<TArgs>;
      })
>;

/**
 * Return type for calling a read-only function.
 */
export type TypedCallReadOnlyFunctionReturnType<
  TAbi extends ClarityAbi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, "read_only">,
> = ContractFunctionReturnType<TAbi, "read_only", TFunctionName>;

/**
 * The raw contract call-read transport used by `readOnly`.
 */
export type CallReadFunction = StacksClientService["callReadFunction"];

export const DEFAULT_SENDER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

function isClarityAbi(abi: ClarityAbi | readonly unknown[]): abi is ClarityAbi {
  return !Array.isArray(abi);
}

/**
 * Calls a read-only contract function.
 *
 * - With an `abi`, arguments are encoded and the result is decoded to the
 *   function's ABI return type.
 * - Without an `abi`, raw hex `args` are forwarded and the result is decoded
 *   into a plain JavaScript value.
 *
 * Clarity-level failures (`okay: false`) are reported as `ReadOnlyCallError`.
 */
export function readOnly<
  const TAbi extends ClarityAbi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, "read_only">,
  const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
>(
  callRead: CallReadFunction,
  parameters: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>,
): Effect.Effect<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError>;

export function readOnly(
  callRead: CallReadFunction,
  parameters: UntypedCallReadOnlyFunctionParameters,
): Effect.Effect<ClarityJsonValue, StacksApiError>;

export function readOnly(
  callRead: CallReadFunction,
  parameters: TypedCallReadOnlyFunctionParameters | UntypedCallReadOnlyFunctionParameters,
): Effect.Effect<ClarityJsonValue, StacksApiError> {
  return Effect.gen(function* readOnly() {
    const { contractId, functionName, senderAddress, tip } = parameters;
    const [contractAddress, contractName] = contractId.split(".");

    if (!contractAddress || !contractName) {
      return yield* Effect.die(
        new Error(
          `Invalid contractId: "${contractId}". Expected format "SP...contract-name" (${functionName})`,
        ),
      );
    }

    const path = `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;
    let hexArgs: string[];

    if ("abi" in parameters) {
      const { abi } = parameters;
      // SAFETY: ContractFunctionArgs constrains TArgs to Clarity argument tuples, which are readonly arrays.
      const functionArgs = (parameters.functionArgs ?? []) as readonly unknown[];
      const abiFunctions = isClarityAbi(abi) ? abi.functions : [];

      const abiFunc = abiFunctions.find(
        (fn: ClarityAbiFunction) => fn.name === functionName && fn.access === "read_only",
      );

      if (!abiFunc) {
        return yield* Effect.die(
          new Error(
            `Function "${functionName}" not found in ABI or is not a read_only function (${path})`,
          ),
        );
      }

      if (functionArgs.length !== abiFunc.args.length) {
        return yield* Effect.die(
          new Error(
            `Function "${functionName}" expects ${abiFunc.args.length} argument(s), but received ${functionArgs.length} (${path})`,
          ),
        );
      }

      try {
        const clarityArgs = primitivesToCVs(functionArgs, abiFunc.args);
        hexArgs = clarityArgs.map((cv) => cvToHex(cv));
      } catch (err) {
        return yield* Effect.die(
          new Error(
            `Failed to encode arguments for function "${functionName}": ${err instanceof Error ? err.message : String(err)} (${path})`,
            { cause: err },
          ),
        );
      }
    } else {
      hexArgs = parameters.args ?? [];
    }

    const response = yield* callRead(contractId, functionName, {
      args: hexArgs,
      sender: senderAddress ?? DEFAULT_SENDER,
      tip,
    });

    if (!response.okay || !response.result) {
      const cause = response.cause ?? "response not okay";

      return yield* new ReadOnlyCallError({
        path,
        message: `Read-only call failed: ${cause}`,
        cause: response,
      });
    }

    try {
      return decodeHex(response.result);
    } catch (err) {
      return yield* new ReadOnlyCallError({
        path,
        message: `Failed to decode read-only result: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  });
}
