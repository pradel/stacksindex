import { cvToHex } from "@stacks/transactions";
import { Result } from "better-result";
import type {
  ClarityAbi,
  ClarityAbiAccess,
  ClarityAbiArgsToPrimitiveTypes,
  ClarityAbiFunction,
  ClarityAbiOutputToPrimitiveType,
  ExtractAbiFunction,
  ExtractAbiFunctionNames,
} from "clarity-abitype";
import { primitivesToCVs } from "clarity-abitype/stacks-js";

import { decodeHex } from "../../codec/index.ts";
import { type StacksApiError, StacksApiParseError, StacksApiUnexpectedError } from "./errors.ts";
import type { CallReadResponse, DatasourceStacksApiContext } from "./index.ts";

export type ContractFunctionName<
  abi extends ClarityAbi | readonly unknown[] = ClarityAbi,
  access extends ClarityAbiAccess = ClarityAbiAccess,
> = abi extends ClarityAbi
  ? ClarityAbi extends abi
    ? string
    : ExtractAbiFunctionNames<abi, access> extends infer functionName extends string
      ? [functionName] extends [never]
        ? string
        : functionName
      : string
  : string;

export type ContractFunctionArgs<
  abi extends ClarityAbi | readonly unknown[] = ClarityAbi,
  access extends ClarityAbiAccess = ClarityAbiAccess,
  functionName extends ContractFunctionName<abi, access> = ContractFunctionName<abi, access>,
> = abi extends ClarityAbi
  ? ClarityAbi extends abi
    ? readonly unknown[]
    : functionName extends ExtractAbiFunctionNames<abi, access>
      ? ExtractAbiFunction<abi, functionName, access>["args"] extends readonly []
        ? readonly []
        : ClarityAbiArgsToPrimitiveTypes<
              ExtractAbiFunction<abi, functionName, access>["args"]
            > extends infer args
          ? [args] extends [never]
            ? readonly unknown[]
            : args
          : readonly unknown[]
      : readonly unknown[]
  : readonly unknown[];

export type ContractFunctionReturnType<
  abi extends ClarityAbi | readonly unknown[] = ClarityAbi,
  access extends ClarityAbiAccess = ClarityAbiAccess,
  functionName extends ContractFunctionName<abi, access> = ContractFunctionName<abi, access>,
> = abi extends ClarityAbi
  ? ClarityAbi extends abi
    ? unknown
    : functionName extends ExtractAbiFunctionNames<abi, access>
      ? ClarityAbiOutputToPrimitiveType<ExtractAbiFunction<abi, functionName, access>["outputs"]>
      : unknown
  : unknown;

export type TypedCallReadOnlyFunctionParameters<
  TAbi extends ClarityAbi | readonly unknown[] = ClarityAbi,
  TFunctionName extends ContractFunctionName<TAbi, "read_only"> = ContractFunctionName<
    TAbi,
    "read_only"
  >,
> = {
  abi: TAbi;
  contractId?: string;
  contractAddress?: string;
  contractName?: string;
  functionName: TFunctionName;
  sender?: string;
  senderAddress?: string;
  tip?: number;
} & (readonly [] extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>
  ? {
      functionArgs?: ContractFunctionArgs<TAbi, "read_only", TFunctionName> | undefined;
      args?: ContractFunctionArgs<TAbi, "read_only", TFunctionName> | undefined;
    }
  :
      | {
          functionArgs: ContractFunctionArgs<TAbi, "read_only", TFunctionName>;
        }
      | {
          args: ContractFunctionArgs<TAbi, "read_only", TFunctionName>;
        });

export type TypedCallReadOnlyFunctionReturnType<
  TAbi extends ClarityAbi | readonly unknown[] = ClarityAbi,
  TFunctionName extends ContractFunctionName<TAbi, "read_only"> = ContractFunctionName<
    TAbi,
    "read_only"
  >,
> = ContractFunctionReturnType<TAbi, "read_only", TFunctionName>;

export async function typedCallReadFunction<
  const TAbi extends ClarityAbi | readonly unknown[],
  TFunctionName extends ContractFunctionName<TAbi, "read_only">,
>(
  context: DatasourceStacksApiContext,
  callReadFn: (
    context: DatasourceStacksApiContext,
    contractId: string,
    functionName: string,
    options?: { args?: string[]; sender?: string; tip?: number },
  ) => Promise<Result<CallReadResponse, StacksApiError>>,
  parameters: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName>,
): Promise<Result<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError>> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const params = parameters as unknown as {
    abi: ClarityAbi;
    functionName: string;
    contractId?: string;
    contractAddress?: string;
    contractName?: string;
    functionArgs?: readonly unknown[];
    args?: readonly unknown[];
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

  const rawArgs = params.functionArgs ?? params.args ?? [];
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
