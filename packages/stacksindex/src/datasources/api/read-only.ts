import { cvToHex } from "@stacks/transactions";
import { Result } from "better-result";
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

import { decodeHex } from "../../codec/index.ts";
import { type StacksApiError, StacksApiParseError, StacksApiUnexpectedError } from "./errors.ts";
import type { CallReadResponse, DatasourceStacksApiContext } from "./index.ts";

export type { ContractFunctionArgs, ContractFunctionName, ContractFunctionReturnType };

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
    /** The contract ID in "address.contract-name" format */
    contractId?: string;
    /** The contract address */
    contractAddress?: string;
    /** The contract name */
    contractName?: string;
    /** The function name to call */
    functionName:
      | ContractFunctionName<TAbi, "read_only">
      | (TFunctionName extends ContractFunctionName<TAbi, "read_only"> ? TFunctionName : never);
    /** The sender address for the simulated call */
    sender?: string;
    /** The sender address for the simulated call (alias) */
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
  TAbi extends ClarityAbi | readonly unknown[] = ClarityAbi,
  TFunctionName extends ContractFunctionName<TAbi, "read_only"> = ContractFunctionName<
    TAbi,
    "read_only"
  >,
> = ContractFunctionReturnType<TAbi, "read_only", TFunctionName>;

/**
 * Type-safe wrapper around Stacks API call-read endpoint.
 */
export async function typedCallReadFunction<
  const TAbi extends ClarityAbi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, "read_only">,
  const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
>(
  context: DatasourceStacksApiContext,
  callReadFn: (
    context: DatasourceStacksApiContext,
    contractId: string,
    functionName: string,
    options?: { args?: string[]; sender?: string; tip?: number },
  ) => Promise<Result<CallReadResponse, StacksApiError>>,
  parameters: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>,
): Promise<Result<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const params = parameters as unknown as {
    abi: ClarityAbi;
    functionName: string;
    contractId?: string;
    contractAddress?: string;
    contractName?: string;
    functionArgs?: readonly unknown[];
    sender?: string;
    senderAddress?: string;
    tip?: number;
  };

  // oxlint-disable-next-line init-declarations
  let contractAddress: string;
  // oxlint-disable-next-line init-declarations
  let contractName: string;

  if (params.contractAddress && params.contractName) {
    ({ contractAddress, contractName } = params);
  } else if (params.contractId) {
    const parts = params.contractId.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return Result.err(
        new StacksApiUnexpectedError({
          message: `Invalid contractId: "${params.contractId}". Expected format: "address.contract-name"`,
          cause: new Error(`Invalid contractId: "${params.contractId}"`),
          path: `/v2/contracts/call-read/${params.contractId}/${params.functionName}`,
        }),
      );
    }
    [contractAddress, contractName] = parts;
  } else {
    return Result.err(
      new StacksApiUnexpectedError({
        message: "Either contractId or both contractAddress and contractName must be provided",
        cause: new Error("Missing contract identification"),
        path: `/v2/contracts/call-read/${params.functionName}`,
      }),
    );
  }

  const abiFunc = params.abi.functions.find(
    (fn: ClarityAbiFunction) => fn.name === params.functionName && fn.access === "read_only",
  );

  if (!abiFunc) {
    return Result.err(
      new StacksApiUnexpectedError({
        message: `Function "${params.functionName}" not found in ABI or is not a read_only function`,
        cause: new Error(`Function "${params.functionName}" not found in ABI`),
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${params.functionName}`,
      }),
    );
  }

  const rawArgs = params.functionArgs ?? [];
  if (rawArgs.length !== abiFunc.args.length) {
    return Result.err(
      new StacksApiUnexpectedError({
        message: `Function "${params.functionName}" expects ${abiFunc.args.length} argument(s), but received ${rawArgs.length}`,
        cause: new Error(`Argument count mismatch for "${params.functionName}"`),
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${params.functionName}`,
      }),
    );
  }

  // oxlint-disable-next-line init-declarations
  let hexArgs: string[];
  try {
    const clarityArgs = primitivesToCVs(rawArgs, abiFunc.args);
    hexArgs = clarityArgs.map((cv) => cvToHex(cv));
  } catch (err) {
    return Result.err(
      new StacksApiUnexpectedError({
        message: `Failed to encode arguments for function "${params.functionName}": ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${params.functionName}`,
      }),
    );
  }

  const sender =
    params.senderAddress ?? params.sender ?? "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

  const callResult = await callReadFn(
    context,
    `${contractAddress}.${contractName}`,
    params.functionName,
    {
      args: hexArgs,
      sender,
      tip: params.tip,
    },
  );

  if (callResult.isErr()) {
    return callResult;
  }

  const response = callResult.value;
  if (!response.okay || !response.result) {
    const cause = response.cause ?? "response not okay";
    return Result.err(
      new StacksApiUnexpectedError({
        message: `Read-only call failed: ${cause}`,
        cause: response,
        path: `/v2/contracts/call-read/${contractAddress}/${contractName}/${params.functionName}`,
      }),
    );
  }

  try {
    const decoded = decodeHex(response.result);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Result.ok(decoded as TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>);
  } catch (err) {
    return Result.err(
      new StacksApiParseError({
        message: `Failed to decode read-only result: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      }),
    );
  }
}
