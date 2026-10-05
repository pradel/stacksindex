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
import { Effect } from "effect";

import { decodeHex } from "../../codec/index.ts";
import { type StacksApiError, StacksApiParseError, StacksApiUnexpectedError } from "./errors.ts";
import type { CallReadResponse, DatasourceStacksApiContext } from "./index.ts";

export type { ContractFunctionArgs, ContractFunctionName, ContractFunctionReturnType };

/**
 * Parameters for calling a read-only function without ABI (raw hex arguments).
 */
export interface UntypedCallReadOnlyFunctionParameters {
  /** The contract address */
  contractAddress: string;
  /** The contract name */
  contractName: string;
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
    /** The contract address */
    contractAddress: string;
    /** The contract name */
    contractName: string;
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

function isClarityAbi(abi: ClarityAbi | readonly unknown[]): abi is ClarityAbi {
  return !Array.isArray(abi);
}

/**
 * Type-safe wrapper around Stacks API call-read endpoint returning an Effect.
 */
export const typedCallReadFunction = <
  const TAbi extends ClarityAbi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, "read_only">,
  const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
  R = never,
>(
  context: DatasourceStacksApiContext,
  callReadFn: (
    context: DatasourceStacksApiContext,
    contractId: string,
    functionName: string,
    options?: { args?: string[]; sender?: string; tip?: number },
  ) => Effect.Effect<CallReadResponse, StacksApiError, R>,
  parameters: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>,
): Effect.Effect<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError, R> =>
  Effect.gen(function* typedCallReadFunction() {
    const { abi, contractAddress, contractName, functionName, senderAddress, tip } = parameters;
    // SAFETY: ContractFunctionArgs constrains TArgs to Clarity argument tuples, which are readonly arrays.
    const functionArgs = (parameters.functionArgs ?? []) as readonly unknown[];
    const abiFunctions = isClarityAbi(abi) ? abi.functions : [];

    const abiFunc = abiFunctions.find(
      (fn: ClarityAbiFunction) => fn.name === functionName && fn.access === "read_only",
    );

    if (!abiFunc) {
      return yield* new StacksApiUnexpectedError({
        message: `Function "${functionName}" not found in ABI or is not a read_only function`,
        cause: new Error(`Function "${functionName}" not found in ABI`),
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`,
      });
    }

    if (functionArgs.length !== abiFunc.args.length) {
      return yield* new StacksApiUnexpectedError({
        message: `Function "${functionName}" expects ${abiFunc.args.length} argument(s), but received ${functionArgs.length}`,
        cause: new Error(`Argument count mismatch for "${functionName}"`),
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`,
      });
    }

    let hexArgs: string[];

    try {
      const clarityArgs = primitivesToCVs(functionArgs, abiFunc.args);
      hexArgs = clarityArgs.map((cv) => cvToHex(cv));
    } catch (err) {
      return yield* new StacksApiUnexpectedError({
        message: `Failed to encode arguments for function "${functionName}": ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`,
      });
    }

    const sender = senderAddress ?? "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

    const response = yield* callReadFn(
      context,
      `${contractAddress}.${contractName}`,
      functionName,
      {
        args: hexArgs,
        sender,
        tip,
      },
    );

    if (!response.okay || !response.result) {
      const cause = response.cause ?? "response not okay";

      return yield* new StacksApiUnexpectedError({
        message: `Read-only call failed: ${cause}`,
        cause: response,
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`,
      });
    }

    try {
      const decoded = decodeHex(response.result);

      // SAFETY: decodeHex parses the on-chain Clarity value, whose shape is fixed by the read-only function's ABI return type.
      return decoded as TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>;
    } catch (err) {
      return yield* new StacksApiParseError({
        message: `Failed to decode read-only result: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  });
