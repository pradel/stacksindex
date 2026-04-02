// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-explicit-any
import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { StacksApiParseError, StacksApiResponseError, StacksApiUnexpectedError } from "./errors.ts";
import { datasourceStacksApi } from "./index.ts";

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  request: mockRequest,
}));

const mockBody = (data: unknown) => ({
  json: () => Promise.resolve(data),
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
      mockRequest.mockReturnValue({
        statusCode: 200,
        body: mockBody({ hash: "0xabc123", block_height: 123_456 }),
      });

      const result = await datasourceStacksApi.getTransaction("0xabc123");
      expect(result).toEqual(Result.ok({ hash: "0xabc123", block_height: 123_456 }));
    });

    test("returns StacksApiResponseError on 404", async () => {
      mockRequest.mockReturnValue({
        statusCode: 404,
        statusText: "Not Found",
        body: mockBody({ error: "Not found" }),
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
      mockRequest.mockReturnValue({
        statusCode: 500,
        statusText: "Internal Server Error",
        body: mockBody({ error: "Internal server error" }),
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
      mockRequest.mockReturnValue({
        statusCode: 200,
        body: {
          json: () => {
            throw new Error("Unexpected end of JSON input");
          },
        },
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
      mockRequest.mockReturnValue({
        statusCode: 500,
        statusText: "Internal Server Error",
        body: {
          json: () => Promise.reject(new Error("parse error")),
          text: () => Promise.resolve("Internal Server Error"),
        },
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
      mockRequest.mockReturnValue({
        statusCode: 500,
        statusText: "Internal Server Error",
        body: {
          json: () => Promise.reject(new Error("parse error")),
          text: () => Promise.reject(new Error("text error")),
        },
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
      mockRequest.mockImplementation(() => {
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
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v2/blocks/0xabc123");
        return {
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", block_height: 123_456 }),
        };
      });

      const result = await datasourceStacksApi.getBlockByHash("0xabc123");
      expect(result).toEqual(Result.ok({ hash: "0xabc123", block_height: 123_456 }));
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

      const result = await datasourceStacksApi.getTransaction("0xtx123");
      expect(result).toEqual(
        Result.ok({ tx_id: "0xtx123", tx_status: "success", block_height: 123_456 }),
      );
    });
  });

  describe("getContractLogs", () => {
    test("returns contract logs on 200 with limit=50", async () => {
      const contractId = "SP123.token";
      const mockLogs = {
        results: [
          {
            tx_id: "0xtx123",
            event_index: 0,
            event_type: "smart_contract_log",
            contract_id: contractId,
            topic: "print",
            value: { hex: "0x01", repr: "123" },
          },
        ],
        next_cursor: "abc123",
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          `https://api.hiro.so/extended/v2/smart-contracts/${contractId}/logs?limit=50`,
        );
        return {
          statusCode: 200,
          body: mockBody(mockLogs),
        };
      });

      const result = await datasourceStacksApi.getContractLogs(contractId);
      expect(result).toEqual(
        Result.ok({
          results: [
            {
              tx_id: "0xtx123",
              event_index: 0,
              event_type: "smart_contract_log",
              contract_id: contractId,
              topic: "print",
              value: { hex: "0x01", repr: "123" },
            },
          ],
          next_cursor: "abc123",
        }),
      );
    });
  });
});
