// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-explicit-any
// oxlint-disable vitest/expect-expect
import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createLogger } from "../../logger/index.ts";
import {
  type StacksApiError,
  StacksApiParseError,
  StacksApiRateLimitError,
  StacksApiResponseError,
  StacksApiUnexpectedError,
} from "./errors.ts";
import { datasourceStacksApi } from "./index.ts";

const mockRequest = vi.hoisted(() => vi.fn());

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: mockRequest,
}));

const mockBody = (data: unknown) => ({
  json: () => Promise.resolve(data),
});

const context = {
  logger: createLogger({ level: 0 }),
};

// Deep-equality on TaggedError instances trips better-result's iterator panic,
// So compare the tag and fields instead.
interface TaggedErrorFields {
  _tag: string;
}

function expectTaggedError(
  result: Result<unknown, StacksApiError>,
  expected: TaggedErrorFields,
): void {
  expect(result.isErr()).toBe(true);
  if (!result.isErr()) {
    throw new Error("expected error result");
  }
  const error = result.error as unknown as Record<string, unknown>;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const expectedFields = expected as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(expectedFields)) {
    expect(error[key]).toStrictEqual(value);
  }
}

describe("aPI DataSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("_request", () => {
    test("returns data on 200", async () => {
      mockRequest.mockReturnValue({
        statusCode: 200,
        body: mockBody({ hash: "0xabc123", block_height: 123_456 }),
      });

      const result = await datasourceStacksApi.getTransaction(context, "0xabc123");
      expect(result).toStrictEqual(Result.ok({ hash: "0xabc123", block_height: 123_456 }));
    });

    test("returns StacksApiResponseError on 404", async () => {
      mockRequest.mockReturnValue({
        statusCode: 404,
        statusText: "Not Found",
        body: mockBody({ error: "Not found" }),
        headers: { "content-type": "application/json" },
      });

      const result = await datasourceStacksApi.getTransaction(context, "404");

      expectTaggedError(
        result,
        new StacksApiResponseError({
          status: 404,
          statusText: "Not Found",
          path: "/extended/v1/tx/404",
          errorData: { error: "Not found" },
        }),
      );
    });

    test("returns StacksApiResponseError on 500", async () => {
      mockRequest.mockReturnValue({
        statusCode: 400,
        statusText: "Bad Request",
        body: mockBody({ error: "Bad request" }),
        headers: { "content-type": "application/json" },
      });

      const result = await datasourceStacksApi.getTransaction(context, "500");

      expectTaggedError(
        result,
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v1/tx/500",
          errorData: { error: "Bad request" },
        }),
      );
    });

    test("returns StacksApiParseError on invalid JSON", async () => {
      mockRequest.mockReturnValue({
        statusCode: 200,
        body: {
          json: () => {
            throw new Error("Unexpected end of JSON input");
          },
        },
        headers: { "content-type": "application/json" },
      });

      const result = await datasourceStacksApi.getTransaction(context, "parse-error");

      expectTaggedError(
        result,
        new StacksApiParseError({
          message: "Unexpected end of JSON input",
          cause: new Error("Unexpected end of JSON input"),
        }),
      );
    });

    test("returns StacksApiResponseError with text error data when JSON fails on error response", async () => {
      mockRequest.mockReturnValue({
        statusCode: 400,
        statusText: "Bad Request",
        body: {
          json: () => Promise.reject(new Error("parse error")),
          text: () => Promise.resolve("Bad Request"),
        },
        headers: { "content-type": "application/json" },
      });

      const result = await datasourceStacksApi.getTransaction(context, "500");

      expectTaggedError(
        result,
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v1/tx/500",
          errorData: "Bad Request",
        }),
      );
    });

    test("returns StacksApiResponseError with null error data when both JSON and text fail", async () => {
      mockRequest.mockReturnValue({
        statusCode: 400,
        statusText: "Bad Request",
        body: {
          json: () => Promise.reject(new Error("parse error")),
          text: () => Promise.reject(new Error("text error")),
        },
        headers: { "content-type": "application/json" },
      });

      const result = await datasourceStacksApi.getTransaction(context, "500");

      expectTaggedError(
        result,
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v1/tx/500",
          errorData: null,
        }),
      );
    });

    test("returns StacksApiUnexpectedError when request throws unexpected error", async () => {
      mockRequest.mockImplementation(() => {
        throw new Error("Network error");
      });

      const result = await datasourceStacksApi.getTransaction(context, "network-error");

      expectTaggedError(
        result,
        new StacksApiUnexpectedError({
          path: "/extended/v1/tx/network-error",
          message: "Unexpected Stacks API error",
          cause: new Error("Network error"),
        }),
      );
    });

    test("retries on 429 after retryAfter seconds and eventually succeeds", async () => {
      vi.useFakeTimers();
      mockRequest
        .mockReturnValueOnce({
          statusCode: 429,
          statusText: "Too Many Requests",
          body: mockBody({ error: "Rate limited" }),
          headers: { "content-type": "application/json", "retry-after": "2" },
        })
        .mockReturnValueOnce({
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", block_height: 123_456 }),
        });

      const promise = datasourceStacksApi.getTransaction(context, "0xabc123");

      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result).toStrictEqual(Result.ok({ hash: "0xabc123", block_height: 123_456 }));
      expect(mockRequest).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("returns StacksApiRateLimitError after exhausting retries on 429", async () => {
      vi.useFakeTimers();
      mockRequest.mockReturnValue({
        statusCode: 429,
        statusText: "Too Many Requests",
        body: mockBody({ error: "Rate limited" }),
        headers: { "content-type": "application/json", "retry-after": "1" },
      });

      const promise = datasourceStacksApi.getTransaction(context, "0xabc123");

      await vi.advanceTimersByTimeAsync(4000);

      const result = await promise;

      expectTaggedError(
        result,
        new StacksApiRateLimitError({
          path: "/extended/v1/tx/0xabc123",
          retryAfter: 1,
        }),
      );
      expect(mockRequest).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    test("retries on 429 with retry-after 0 without delay", async () => {
      vi.useFakeTimers();
      mockRequest
        .mockReturnValueOnce({
          statusCode: 429,
          statusText: "Too Many Requests",
          body: mockBody({ error: "Rate limited" }),
          headers: { "content-type": "application/json", "retry-after": "0" },
        })
        .mockReturnValueOnce({
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", block_height: 123_456 }),
        });

      const promise = datasourceStacksApi.getTransaction(context, "0xabc123");

      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;

      expect(result).toStrictEqual(Result.ok({ hash: "0xabc123", block_height: 123_456 }));
      expect(mockRequest).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe("getBlockByHash", () => {
    test("returns block data on 200", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v2/blocks/0xabc123");
        return {
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", block_height: 123_456 }),
        };
      });

      const result = await datasourceStacksApi.getBlockByHash(context, "0xabc123");
      expect(result).toStrictEqual(Result.ok({ hash: "0xabc123", block_height: 123_456 }));
    });
  });

  describe("getTransaction", () => {
    test("returns transaction data on 200", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v1/tx/0xtx123");
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123", tx_status: "success", block_height: 123_456 }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(context, "0xtx123");
      expect(result).toStrictEqual(
        Result.ok({ tx_id: "0xtx123", tx_status: "success", block_height: 123_456 }),
      );
    });
  });

  describe("getAddressTransactions", () => {
    test("returns address transactions on 200", async () => {
      const address = "SP123.token";
      const mockResponse = {
        limit: 50,
        offset: 100,
        total: 200,
        results: [{ tx_id: "0xtx123", block_height: 123_456 }],
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          `https://api.hiro.so/extended/v1/address/${address}/transactions?limit=50&offset=100&exclude_function_args=true`,
        );
        return {
          statusCode: 200,
          body: mockBody(mockResponse),
        };
      });

      const result = await datasourceStacksApi.getAddressTransactions(context, address, {
        limit: 50,
        offset: 100,
      });
      expect(result).toStrictEqual(Result.ok(mockResponse));
    });
  });

  describe("getContractLogs", () => {
    test("returns contract logs on 200", async () => {
      const contractId = "SP123.token";
      const mockLogs = {
        results: [
          {
            tx_id: "0xtx123",
            event_index: 0,
            event_type: "smart_contract_log",
            contract_log: {
              contract_id: contractId,
              topic: "print",
              value: { hex: "0x01", repr: "123" },
            },
          },
        ],
        next_cursor: "abc123",
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          `https://api.hiro.so/extended/v2/smart-contracts/${contractId}/logs?limit=100`,
        );
        return {
          statusCode: 200,
          body: mockBody(mockLogs),
        };
      });

      const result = await datasourceStacksApi.getContractLogs(context, contractId);
      expect(result).toStrictEqual(
        Result.ok({
          results: [
            {
              tx_id: "0xtx123",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_log: {
                contract_id: contractId,
                topic: "print",
                value: { hex: "0x01", repr: "123" },
              },
            },
          ],
          next_cursor: "abc123",
        }),
      );
    });
  });

  describe("custom baseUrl and apiKey", () => {
    test("uses custom baseUrl when provided", async () => {
      mockRequest.mockImplementation((url: string, init: Record<string, unknown>) => {
        expect(url).toBe("https://api.testnet.hiro.so/extended/v1/tx/0xtx123");
        expect(init.headers).toBeUndefined();
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123" }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(
        { logger: context.logger, baseUrl: "https://api.testnet.hiro.so" },
        "0xtx123",
      );
      expect(result.isOk()).toBe(true);
    });

    test("defaults to mainnet api.hiro.so", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v1/tx/0xtx123");
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123" }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(
        { logger: context.logger },
        "0xtx123",
      );
      expect(result.isOk()).toBe(true);
    });

    test("sends x-api-key header when apiKey provided", async () => {
      mockRequest.mockImplementation((url: string, init: Record<string, unknown>) => {
        expect(init.headers).toStrictEqual({ "x-api-key": "test-key" });
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123" }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(
        { logger: context.logger, apiKey: "test-key" },
        "0xtx123",
      );
      expect(result.isOk()).toBe(true);
    });

    test("sends content-type and x-api-key together on POST", async () => {
      mockRequest.mockImplementation((url: string, init: Record<string, unknown>) => {
        expect(init.method).toBe("POST");
        expect(init.headers).toStrictEqual({
          "content-type": "application/json",
          "x-api-key": "test-key",
        });
        return {
          statusCode: 200,
          body: mockBody({ okay: true, result: "0x03" }),
        };
      });

      const result = await datasourceStacksApi.callReadFunction(
        { logger: context.logger, apiKey: "test-key" },
        "SP123.token",
        "get-decimals",
      );
      expect(result.isOk()).toBe(true);
    });

    test("passes tip as a query parameter", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          "https://api.hiro.so/v2/contracts/call-read/SP123/token/get-decimals?tip=150450",
        );
        return {
          statusCode: 200,
          body: mockBody({ okay: true, result: "0x03" }),
        };
      });

      const result = await datasourceStacksApi.callReadFunction(
        { logger: context.logger },
        "SP123.token",
        "get-decimals",
        { tip: 150_450 },
      );
      expect(result.isOk()).toBe(true);
    });

    test("omits tip query parameter when not provided", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/v2/contracts/call-read/SP123/token/get-pool-count");
        return {
          statusCode: 200,
          body: mockBody({ okay: true, result: "0x03" }),
        };
      });

      const result = await datasourceStacksApi.callReadFunction(
        { logger: context.logger },
        "SP123.token",
        "get-pool-count",
      );
      expect(result.isOk()).toBe(true);
    });

    test("returns parse error for contract ids without a contract name", async () => {
      const result = await datasourceStacksApi.callReadFunction(
        { logger: context.logger },
        "SP123",
        "get-pool-count",
      );
      expectTaggedError(
        result,
        new StacksApiParseError({
          message: 'Invalid contract id, expected "address.contract-name": SP123',
          cause: null,
        }),
      );
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });
});
