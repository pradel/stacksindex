import { Result } from "better-result";
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createLogger } from "../../logger/index.ts";
import {
  StacksApiParseError,
  StacksApiRateLimitError,
  StacksApiResponseError,
  StacksApiUnexpectedError,
} from "./errors.ts";
import { datasourceStacksApi } from "./index.ts";

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  request: mockRequest,
}));

const mockBody = (data: unknown) => ({
  json: () => Promise.resolve(data),
});

const context = {
  logger: createLogger({ level: 0 }),
};

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

      expect(result).toBeBetterErr(
        new StacksApiResponseError({
          status: 404,
          statusText: "Not Found",
          path: "/extended/v3/transactions/404",
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

      expect(result).toBeBetterErr(
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v3/transactions/500",
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

      expect(result).toBeBetterErr(
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

      expect(result).toBeBetterErr(
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v3/transactions/500",
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

      expect(result).toBeBetterErr(
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v3/transactions/500",
          errorData: null,
        }),
      );
    });

    test("returns StacksApiUnexpectedError when request throws unexpected error", async () => {
      mockRequest.mockImplementation(() => {
        throw new Error("Network error");
      });

      const result = await datasourceStacksApi.getTransaction(context, "network-error");

      expect(result).toBeBetterErr(
        new StacksApiUnexpectedError({
          message: "Unexpected Stacks API error",
          cause: new Error("Network error"),
          path: "/extended/v3/transactions/network-error",
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

      expect(result).toBeBetterErr(
        new StacksApiRateLimitError({
          path: "/extended/v3/transactions/0xabc123",
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

  describe("getBlock", () => {
    test("returns block data on 200 by hash", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v2/blocks/0xabc123");
        return {
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", height: 123_456 }),
        };
      });

      const result = await datasourceStacksApi.getBlock(context, "0xabc123");
      expect(result).toStrictEqual(Result.ok({ hash: "0xabc123", height: 123_456 }));
    });

    test("returns block data on 200 by height", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v2/blocks/123456");
        return {
          statusCode: 200,
          body: mockBody({ hash: "0xabc123", height: 123_456 }),
        };
      });

      const result = await datasourceStacksApi.getBlock(context, 123_456);
      expect(result).toStrictEqual(Result.ok({ hash: "0xabc123", height: 123_456 }));
    });
  });

  describe("getBlockTransactions", () => {
    test("returns block transactions on 200 with cursor and limit", async () => {
      const mockResponse = {
        total: 1,
        limit: 20,
        cursor: {
          next: "100:0:1",
          previous: null,
          current: "100:0:0",
        },
        results: [
          {
            tx_id: "0xtx123",
            type: "contract_call",
            status: "success",
          },
        ],
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          "https://api.hiro.so/extended/v3/blocks/0xabc123/transactions?limit=20&cursor=100%3A0%3A0",
        );
        return {
          statusCode: 200,
          body: mockBody(mockResponse),
        };
      });

      const result = await datasourceStacksApi.getBlockTransactions(context, "0xabc123", {
        limit: 20,
        cursor: "100:0:0",
      });
      expect(result).toStrictEqual(Result.ok(mockResponse));
    });

    test("returns block transactions by height", async () => {
      const mockResponse = {
        total: 0,
        limit: 20,
        cursor: {
          next: null,
          previous: null,
          current: null,
        },
        results: [],
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v3/blocks/123456/transactions");
        return {
          statusCode: 200,
          body: mockBody(mockResponse),
        };
      });

      const result = await datasourceStacksApi.getBlockTransactions(context, 123_456);
      expect(result).toStrictEqual(Result.ok(mockResponse));
    });
  });

  describe("getTransaction", () => {
    test("returns transaction data on 200", async () => {
      const mockTx = {
        tx_id: "0xtx123",
        type: "contract_call",
        status: "success",
        fee_rate: "1000",
        sender: { address: "SP123", nonce: 1 },
        block: { hash: "0xblock", height: 123_456, time: 1000, tx_index: 0 },
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v3/transactions/0xtx123");
        return {
          statusCode: 200,
          body: mockBody(mockTx),
        };
      });

      const result = await datasourceStacksApi.getTransaction(context, "0xtx123");
      expect(result).toStrictEqual(Result.ok(mockTx));
    });

    test("includes optional fields when requested", async () => {
      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          "https://api.hiro.so/extended/v3/transactions/0xtx123?include=result%2Cpost_conditions",
        );
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123" }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(context, "0xtx123", {
        include: ["result", "post_conditions"],
      });
      expect(result).toStrictEqual(Result.ok({ tx_id: "0xtx123" }));
    });
  });

  describe("getV1Transaction", () => {
    test("returns v1 transaction data on 200", async () => {
      const mockV1Tx = {
        tx_id: "0xtx123",
        tx_type: "contract_call",
        tx_status: "success",
        block_height: 123_456,
        tx_index: 6,
        microblock_sequence: 2147483647,
        microblock_hash: "0x",
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://api.hiro.so/extended/v1/tx/0xtx123");
        return {
          statusCode: 200,
          body: mockBody(mockV1Tx),
        };
      });

      const result = await datasourceStacksApi.getV1Transaction(context, "0xtx123");
      expect(result).toStrictEqual(Result.ok(mockV1Tx));
    });
  });

  describe("getTransactionsBatch", () => {
    test("returns batch data on 200 with repeated tx_id params", async () => {
      const mockResponse = {
        results: [
          {
            tx_id: "0xtx2",
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP123", nonce: 1 },
            block: { hash: "0xblock2", height: 2, time: 2000, tx_index: 0 },
          },
          {
            tx_id: "0xtx1",
            type: "contract_call",
            status: "success",
            fee_rate: "1000",
            sender: { address: "SP123", nonce: 0 },
            block: { hash: "0xblock1", height: 1, time: 1000, tx_index: 0 },
          },
        ],
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          "https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xtx1&tx_id=0xtx2",
        );
        return {
          statusCode: 200,
          body: mockBody(mockResponse),
        };
      });

      const result = await datasourceStacksApi.getTransactionsBatch(context, ["0xtx1", "0xtx2"]);
      expect(result).toStrictEqual(Result.ok(mockResponse));
    });

    test("returns empty results without a request when txIds is empty", async () => {
      const result = await datasourceStacksApi.getTransactionsBatch(context, []);
      expect(result).toStrictEqual(Result.ok({ results: [] }));
      expect(mockRequest).not.toHaveBeenCalled();
    });

    test("returns StacksApiResponseError on 404", async () => {
      mockRequest.mockReturnValue({
        statusCode: 404,
        statusText: "Not Found",
        body: mockBody({ error: "Not found" }),
        headers: { "content-type": "application/json" },
      });

      const result = await datasourceStacksApi.getTransactionsBatch(context, ["0xtx1"]);

      expect(result).toBeBetterErr(
        new StacksApiResponseError({
          status: 404,
          statusText: "Not Found",
          path: "/extended/v3/transactions/batch",
          errorData: { error: "Not found" },
        }),
      );
    });
  });

  describe("getTransactionEvents", () => {
    test("returns transaction events on 200", async () => {
      const txId = "0xtx123";
      const mockResponse = {
        limit: 50,
        total: 1,
        cursor: { next: null, previous: null, current: "0" },
        results: [
          {
            event_index: 0,
            type: "contract_log",
            contract_log: {
              contract_id: "SP123.token",
              topic: "print",
              value: { hex: "0x01", repr: "123" },
            },
          },
        ],
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(`https://api.hiro.so/extended/v3/transactions/${txId}/events?limit=50`);
        return {
          statusCode: 200,
          body: mockBody(mockResponse),
        };
      });

      const result = await datasourceStacksApi.getTransactionEvents(context, txId, { limit: 50 });
      expect(result).toStrictEqual(Result.ok(mockResponse));
    });
  });

  describe("getPrincipalTransactions", () => {
    test("returns principal transactions on 200 with cursor", async () => {
      const principal = "SP123.token";
      const mockResponse = {
        limit: 50,
        total: 200,
        cursor: { next: "next_cursor_1", previous: null, current: "curr_1" },
        results: [
          {
            transaction: {
              tx_id: "0xtx123",
              type: "contract_call",
              status: "success",
              fee_rate: "1000",
              sender: { address: principal, nonce: 0 },
              block: { hash: "0xblock", height: 123_456, time: 1000, tx_index: 0 },
            },
            involvement: "sender",
          },
        ],
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(
          `https://api.hiro.so/extended/v3/principals/${principal}/transactions?limit=50&cursor=curr_1`,
        );
        return {
          statusCode: 200,
          body: mockBody(mockResponse),
        };
      });

      const result = await datasourceStacksApi.getPrincipalTransactions(context, principal, {
        limit: 50,
        cursor: "curr_1",
      });
      expect(result).toStrictEqual(Result.ok(mockResponse));
    });
  });

  describe("getContract", () => {
    test("returns contract info on 200", async () => {
      const contractId = "SP123.token";
      const mockContract = {
        tx_id: "0xtx123",
        contract_id: contractId,
        block: {
          height: 123_456,
          hash: "0xhash",
          index_hash: "0xindex",
          time: 1_600_000_000,
          tx_index: 0,
        },
        bitcoin_block: {
          height: 100_000,
          time: 1_600_000_000,
        },
        clarity_version: 2,
        source_code: "(define-data-var x int 0)",
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe(`https://api.hiro.so/extended/v3/smart-contracts/${contractId}`);
        return {
          statusCode: 200,
          body: mockBody(mockContract),
        };
      });

      const result = await datasourceStacksApi.getContract(context, contractId);
      expect(result).toStrictEqual(Result.ok(mockContract));
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

  describe("baseUrl and apiKey configuration", () => {
    test("uses custom baseUrl", async () => {
      const customContext = {
        ...context,
        api: {
          baseUrl: "https://custom-stacks-node.example.com",
        },
      };

      mockRequest.mockImplementation((url: string) => {
        expect(url).toBe("https://custom-stacks-node.example.com/extended/v3/transactions/0xtx123");
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123", block: { height: 123_456 } }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(customContext, "0xtx123");
      expect(result).toStrictEqual(Result.ok({ tx_id: "0xtx123", block: { height: 123_456 } }));
    });

    test("sends x-api-key header when apiKey is provided", async () => {
      const apiKeyContext = {
        ...context,
        api: {
          apiKey: "my-test-api-key",
        },
      };

      mockRequest.mockImplementation((url: string, init: { headers: Record<string, string> }) => {
        expect(url).toBe("https://api.hiro.so/extended/v3/transactions/0xtx123");
        expect(init.headers["x-api-key"]).toBe("my-test-api-key");
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123", block: { height: 123_456 } }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(apiKeyContext, "0xtx123");
      expect(result).toStrictEqual(Result.ok({ tx_id: "0xtx123", block: { height: 123_456 } }));
    });

    test("does not send x-api-key header when apiKey is not provided", async () => {
      mockRequest.mockImplementation((_url: string, init: { headers: Record<string, string> }) => {
        expect(init.headers["x-api-key"]).toBeUndefined();
        return {
          statusCode: 200,
          body: mockBody({ tx_id: "0xtx123", block: { height: 123_456 } }),
        };
      });

      const result = await datasourceStacksApi.getTransaction(context, "0xtx123");
      expect(result).toStrictEqual(Result.ok({ tx_id: "0xtx123", block: { height: 123_456 } }));
    });

    test("sends both x-api-key and content-type on POST requests", async () => {
      const apiKeyContext = {
        ...context,
        api: {
          baseUrl: "https://custom-stacks-node.example.com",
          apiKey: "my-test-api-key",
        },
      };

      mockRequest.mockImplementation(
        (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
          expect(url).toBe(
            "https://custom-stacks-node.example.com/v2/contracts/call-read/SP123/contract/my-function",
          );
          expect(init.method).toBe("POST");
          expect(init.headers["x-api-key"]).toBe("my-test-api-key");
          expect(init.headers["content-type"]).toBe("application/json");
          expect(JSON.parse(init.body)).toMatchObject({
            sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
            arguments: [],
          });
          return {
            statusCode: 200,
            body: mockBody({ okay: true, result: "0x01" }),
          };
        },
      );

      const result = await datasourceStacksApi.callReadFunction(
        apiKeyContext,
        "SP123.contract",
        "my-function",
      );
      expect(result).toStrictEqual(Result.ok({ okay: true, result: "0x01" }));
    });
  });

  describe("getStatus", () => {
    test("calls /extended endpoint and returns status response on 200", async () => {
      const mockResponse = {
        server_version: "stacks-node-api:v1.0.0",
        status: "ready",
        chain_tip: { block_height: 100 },
      };
      mockRequest.mockReturnValue({
        statusCode: 200,
        body: mockBody(mockResponse),
        headers: { "content-type": "application/json" },
      });

      const result = await datasourceStacksApi.getStatus(context);
      expect(result).toStrictEqual(Result.ok(mockResponse));
      expect(mockRequest).toHaveBeenCalledWith(
        "https://api.hiro.so/extended",
        expect.objectContaining({ method: "GET" }),
      );
    });
  });
});
