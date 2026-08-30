// oxlint-disable vitest/no-conditional-expect, vitest/no-conditional-in-test, vitest/prefer-called-times, vitest/prefer-describe-function-title

import { Result } from "better-result";
import type { ClarityAbi } from "clarity-abitype";
import { describe, expect, it, vi } from "vite-plus/test";

import { createLogger } from "../../logger/index.ts";
import { StacksApiResponseError, StacksApiUnexpectedError } from "./errors.ts";
import type { CallReadResponse, DatasourceStacksApiContext } from "./index.ts";
import { typedCallReadFunction } from "./read-only.ts";

const sampleTokenAbi = {
  functions: [
    {
      name: "get-name",
      access: "read_only",
      args: [],
      outputs: {
        type: {
          response: {
            ok: { "string-ascii": { length: 32 } },
            error: "none",
          },
        },
      },
    },
    {
      name: "get-decimals",
      access: "read_only",
      args: [],
      outputs: {
        type: {
          response: {
            ok: "uint128",
            error: "none",
          },
        },
      },
    },
    {
      name: "get-balance",
      access: "read_only",
      args: [{ name: "account", type: "principal" }],
      outputs: {
        type: {
          response: {
            ok: "uint128",
            error: "none",
          },
        },
      },
    },
    {
      name: "get-pool-details",
      access: "read_only",
      args: [
        { name: "pool-id", type: "uint128" },
        {
          name: "metadata",
          type: {
            tuple: [
              { name: "tag", type: { "string-ascii": { length: 10 } } },
              { name: "active", type: "bool" },
            ],
          },
        },
      ],
      outputs: {
        type: {
          response: {
            ok: {
              tuple: [
                { name: "token-x", type: "principal" },
                { name: "token-y", type: "principal" },
                { name: "fee", type: "uint128" },
              ],
            },
            error: "uint128",
          },
        },
      },
    },
    {
      name: "transfer",
      access: "public",
      args: [
        { name: "amount", type: "uint128" },
        { name: "recipient", type: "principal" },
      ],
      outputs: {
        type: {
          response: {
            ok: "bool",
            error: "uint128",
          },
        },
      },
    },
  ],
  variables: [],
  maps: [],
  fungible_tokens: [],
  non_fungible_tokens: [],
} as const satisfies ClarityAbi;

describe("typedCallReadFunction", () => {
  const logger = createLogger({ level: 0 });
  const context: DatasourceStacksApiContext = { logger };

  it("calls 0-argument read-only function and decodes response ok", async () => {
    const mockCallRead = vi
      .fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >()
      .mockResolvedValue(
        Result.ok({
          okay: true,
          result: "0x070d0000000954657374546f6b656e",
        }),
      );

    const result = await typedCallReadFunction(context, mockCallRead, {
      abi: sampleTokenAbi,
      contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      functionName: "get-name",
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toStrictEqual({ ok: "TestToken" });
    }

    expect(mockCallRead).toHaveBeenCalledWith(
      context,
      "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      "get-name",
      {
        args: [],
        sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
        tip: undefined,
      },
    );
  });

  it("supports contractAddress and contractName properties", async () => {
    const mockCallRead = vi
      .fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >()
      .mockResolvedValue(
        Result.ok({
          okay: true,
          result: "0x070100000000000000000000000000000008",
        }),
      );

    const result = await typedCallReadFunction(context, mockCallRead, {
      abi: sampleTokenAbi,
      contractAddress: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
      contractName: "test-token",
      functionName: "get-decimals",
      sender: "SP12345SENDER",
      tip: 100500,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toStrictEqual({ ok: 8n });
    }

    expect(mockCallRead).toHaveBeenCalledWith(
      context,
      "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      "get-decimals",
      {
        args: [],
        sender: "SP12345SENDER",
        tip: 100500,
      },
    );
  });

  it("encodes primitive arguments (principal) and decodes response", async () => {
    const mockCallRead = vi
      .fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >()
      .mockResolvedValue(
        Result.ok({
          okay: true,
          result: "0x0701000000000000000000000000004c4b40",
        }),
      );

    const result = await typedCallReadFunction(context, mockCallRead, {
      abi: sampleTokenAbi,
      contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      functionName: "get-balance",
      functionArgs: ["SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9"],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toStrictEqual({ ok: 5000000n });
    }

    expect(mockCallRead).toHaveBeenCalledOnce();
    const passedOptions = mockCallRead.mock.calls[0]?.[3];
    expect(passedOptions?.args).toHaveLength(1);
    expect(passedOptions?.args?.[0]).toBeTypeOf("string");
    expect(passedOptions?.args?.[0].startsWith("0x")).toBe(true);
  });

  it("encodes complex tuple arguments and decodes nested tuple response", async () => {
    const mockCallRead = vi
      .fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >()
      .mockResolvedValue(
        Result.ok({
          okay: true,
          result:
            "0x070c0000000303666565010000000000000000000000000000001e07746f6b656e2d78051a5c64c514ffab1adbbddc6ecffbaebfbbfaeedc5307746f6b656e2d79051a5c64c514ffab1adbbddc6ecffbaebfbbfaeedc53",
        }),
      );

    const result = await typedCallReadFunction(context, mockCallRead, {
      abi: sampleTokenAbi,
      contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      functionName: "get-pool-details",
      functionArgs: [
        1n,
        {
          tag: "alex",
          active: true,
        },
      ],
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toHaveProperty("ok");
    }

    const passedOptions = mockCallRead.mock.calls[0]?.[3];
    expect(passedOptions?.args).toHaveLength(2);
  });

  it("returns error if function is public instead of read_only", async () => {
    const mockCallRead =
      vi.fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const params = {
      abi: sampleTokenAbi,
      contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      functionName: "transfer",
      functionArgs: [100n, "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9"],
    } as unknown as Parameters<typeof typedCallReadFunction>[2];

    const result = await typedCallReadFunction(context, mockCallRead, params);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(StacksApiUnexpectedError.is(result.error)).toBe(true);
      expect(result.error.message).toContain("not found in ABI or is not a read_only function");
    }
    expect(mockCallRead).not.toHaveBeenCalled();
  });

  it("returns error if contractId is malformed", async () => {
    const mockCallRead =
      vi.fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const params = {
      abi: sampleTokenAbi,
      contractId: "INVALID_ID_WITHOUT_DOT",
      functionName: "get-name",
    } as unknown as Parameters<typeof typedCallReadFunction>[2];

    const result = await typedCallReadFunction(context, mockCallRead, params);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Invalid contractId");
    }
  });

  it("returns error if argument count mismatches ABI", async () => {
    const mockCallRead =
      vi.fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const params = {
      abi: sampleTokenAbi,
      contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      functionName: "get-balance",
      functionArgs: [],
    } as unknown as Parameters<typeof typedCallReadFunction>[2];

    const result = await typedCallReadFunction(context, mockCallRead, params);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("Failed to encode arguments");
    }
  });

  it("returns error when API call returns okay: false", async () => {
    const mockCallRead = vi
      .fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiUnexpectedError>>
      >()
      .mockResolvedValue(
        Result.ok({
          okay: false,
          result: "",
          cause: "NoSuchContract",
        }),
      );

    const result = await typedCallReadFunction(context, mockCallRead, {
      abi: sampleTokenAbi,
      contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      functionName: "get-name",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain("NoSuchContract");
    }
  });

  it("propagates HTTP/API errors from datasource call", async () => {
    const apiError = new StacksApiResponseError({
      status: 500,
      statusText: "Internal Server Error",
      path: "/v2/contracts/call-read/...",
      errorData: null,
    });

    const mockCallRead = vi
      .fn<
        (
          context: DatasourceStacksApiContext,
          contractId: string,
          functionName: string,
          options?: { args?: string[]; sender?: string; tip?: number },
        ) => Promise<Result<CallReadResponse, StacksApiResponseError>>
      >()
      .mockResolvedValue(Result.err(apiError));

    const result = await typedCallReadFunction(context, mockCallRead, {
      abi: sampleTokenAbi,
      contractId: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.test-token",
      functionName: "get-name",
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe(apiError);
    }
  });
});
