import { Result } from "better-result";
import { describe, test, expect, vi, beforeEach, afterAll } from "vite-plus/test";

import { StacksApiResponseError } from "./errors.ts";
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

      const result = await datasourceStacksApi.getBlockByHash("0xabc123");
      expect(result).toEqual(Result.ok({ hash: "0xabc123", block_height: 123456 }));
    });

    test("returns StacksApiResponseError on 404", async () => {
      mockRequest.mockImplementation(async () => {
        return {
          statusCode: 404,
          body: mockBody({ error: "Not found" }),
        };
      });

      const result = await datasourceStacksApi.getTransaction("404");

      expect(result).toEqual(
        Result.err(
          new StacksApiResponseError({
            errorData: { error: "Not found" },
            status: 404,
            path: "test",
            statusText: "test",
          }),
        ),
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
