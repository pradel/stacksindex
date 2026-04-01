import { Result } from "better-result";
import { describe, test, expect, vi, beforeEach, afterAll } from "vite-plus/test";

import { StacksApiUnexpectedError, StacksApiParseError, StacksApiResponseError } from "./errors.ts";
import { datasourceStacksApi } from "./index.ts";

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  request: mockRequest,
}));

const mockBody = (data: unknown) => ({
  json: async () => data,
});

describe("API DataSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("_request", () => {
    test("returns data on 200", async () => {
      mockRequest.mockImplementation(async () => {
        return {
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", block_height: 123456 }),
        };
      });

      const result = await datasourceStacksApi.getTransaction("0xabc123");
      expect(result).toEqual(Result.ok({ hash: "0xabc123", block_height: 123456 }));
    });

    test("returns StacksApiResponseError on 404", async () => {
      mockRequest.mockImplementation(async () => {
        return {
          statusCode: 404,
          statusText: "Not Found",
          body: mockBody({ error: "Not found" }),
        };
      });

      const result = await datasourceStacksApi.getTransaction("404");

      expect(result.isErr()).toBe(true);
      expect((result as any).error).toEqual(
        new StacksApiResponseError({
          status: 404,
          statusText: "Not Found",
          path: "/extended/v1/tx/404",
          errorData: { error: "Not found" },
        }),
      );
    });

    test("returns StacksApiResponseError on 500", async () => {
      mockRequest.mockImplementation(async () => {
        return {
          statusCode: 500,
          statusText: "Internal Server Error",
          body: mockBody({ error: "Internal server error" }),
        };
      });

      const result = await datasourceStacksApi.getTransaction("500");

      expect(result.isErr()).toBe(true);
      expect((result as any).error).toEqual(
        new StacksApiResponseError({
          status: 500,
          statusText: "Internal Server Error",
          path: "/extended/v1/tx/500",
          errorData: { error: "Internal server error" },
        }),
      );
    });

    test("returns StacksApiParseError on invalid JSON", async () => {
      mockRequest.mockImplementation(async () => {
        return {
          statusCode: 200,
          body: {
            json: async () => {
              throw new Error("Unexpected end of JSON input");
            },
          },
        };
      });

      const result = await datasourceStacksApi.getTransaction("parse-error");

      expect(result.isErr()).toBe(true);
      expect((result as any).error).toEqual(
        new StacksApiParseError({
          message: "Unexpected end of JSON input",
          cause: new Error("Unexpected end of JSON input"),
        }),
      );
    });

    test("returns StacksApiResponseError with text error data when JSON fails on error response", async () => {
      mockRequest.mockImplementation(async () => {
        return {
          statusCode: 500,
          statusText: "Internal Server Error",
          body: {
            json: async () => {
              throw new Error("parse error");
            },
            text: async () => "Internal Server Error",
          },
        };
      });

      const result = await datasourceStacksApi.getTransaction("500");

      expect(result.isErr()).toBe(true);
      expect((result as any).error).toEqual(
        new StacksApiResponseError({
          status: 500,
          statusText: "Internal Server Error",
          path: "/extended/v1/tx/500",
          errorData: "Internal Server Error",
        }),
      );
    });

    test("returns StacksApiResponseError with null error data when both JSON and text fail", async () => {
      mockRequest.mockImplementation(async () => {
        return {
          statusCode: 500,
          statusText: "Internal Server Error",
          body: {
            json: async () => {
              throw new Error("parse error");
            },
            text: async () => {
              throw new Error("text error");
            },
          },
        };
      });

      const result = await datasourceStacksApi.getTransaction("500");

      expect(result.isErr()).toBe(true);
      expect((result as any).error).toEqual(
        new StacksApiResponseError({
          status: 500,
          statusText: "Internal Server Error",
          path: "/extended/v1/tx/500",
          errorData: null,
        }),
      );
    });

    test("returns StacksApiUnexpectedError when request throws unexpected error", async () => {
      mockRequest.mockImplementation(async () => {
        throw new Error("Network error");
      });

      const result = await datasourceStacksApi.getTransaction("network-error");

      expect(result.isErr()).toBe(true);
      expect((result as any).error).toEqual(
        new StacksApiUnexpectedError({
          path: "/extended/v1/tx/network-error",
          message: "Unexpected Stacks API error",
          cause: new Error("Network error"),
        }),
      );
    });
  });

  describe("getBlockByHash", () => {
    test("returns block data on 200", async () => {
      mockRequest.mockImplementation(async (url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v2/blocks/0xabc123");
        return {
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", block_height: 123456 }),
        };
      });

      const result = await datasourceStacksApi.getBlockByHash("0xabc123");
      expect(result).toEqual(Result.ok({ hash: "0xabc123", block_height: 123456 }));
    });
  });

  describe("getTransaction", () => {
    test("returns transaction data on 200", async () => {
      mockRequest.mockImplementation(async (url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v1/tx/0xtx123");
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123", tx_status: "success", block_height: 123456 }),
        };
      });

      const result = await datasourceStacksApi.getTransaction("0xtx123");
      expect(result).toEqual(
        Result.ok({ tx_id: "0xtx123", tx_status: "success", block_height: 123456 }),
      );
    });
  });
});
