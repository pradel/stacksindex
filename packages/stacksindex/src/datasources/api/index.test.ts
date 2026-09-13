// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-explicit-any
import { Effect } from "effect";
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createLogger } from "../../logger/index.ts";
import { StacksApiRateLimitError, StacksApiResponseError } from "./errors.ts";
import { datasourceStacksApi } from "./index.ts";

const mockFetch = vi.fn();

const toUrlString = (url: unknown) =>
  typeof url === "string" ? url : ((url as URL).href ?? String(url));

const jsonResponse = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(typeof data === "string" ? data : JSON.stringify(data), {
    status,
    statusText:
      status === 200
        ? "OK"
        : status === 400
          ? "Bad Request"
          : status === 404
            ? "Not Found"
            : status === 429
              ? "Too Many Requests"
              : status === 500
                ? "Internal Server Error"
                : String(status),
    headers: {
      "content-type": typeof data === "string" ? "text/plain" : "application/json",
      ...headers,
    },
  });

const context = {
  logger: createLogger({ level: 0 }),
};

describe("aPI DataSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", mockFetch);
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("_request", () => {
    test("returns data on 200", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransaction(context, "0xabc123"),
      );
      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
    });

    test("returns StacksApiResponseError on 404", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: "Not found" }, 404));

      const exit = await Effect.runPromiseExit(datasourceStacksApi.getTransaction(context, "404"));

      expect(exit).toBeTaggedError(
        new StacksApiResponseError({
          status: 404,
          statusText: "Not Found",
          path: "/extended/v3/transactions/404",
          errorData: { error: "Not found" },
        }),
      );
    });

    test("returns StacksApiResponseError on 500", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: "Bad request" }, 400));

      const exit = await Effect.runPromiseExit(datasourceStacksApi.getTransaction(context, "500"));

      expect(exit).toBeTaggedError(
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v3/transactions/500",
          errorData: { error: "Bad request" },
        }),
      );
    });

    test("returns StacksApiParseError on invalid JSON", async () => {
      mockFetch.mockResolvedValue(
        new Response("invalid json {", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        }),
      );

      const exit = await Effect.runPromiseExit(
        datasourceStacksApi.getTransaction(context, "parse-error"),
      );

      expect(exit).toBeTaggedError({
        _tag: "StacksApiParseError",
      });
    });

    test("returns StacksApiResponseError with text error data when JSON fails on error response", async () => {
      mockFetch.mockResolvedValue(
        new Response("Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "text/plain" },
        }),
      );

      const exit = await Effect.runPromiseExit(datasourceStacksApi.getTransaction(context, "500"));

      expect(exit).toBeTaggedError(
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v3/transactions/500",
          errorData: "Bad Request",
        }),
      );
    });

    test("returns StacksApiResponseError with null error data when both JSON and text fail", async () => {
      const mockBrokenResponse = {
        status: 400,
        statusText: "Bad Request",
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.reject(new Error("parse error")),
        text: () => Promise.reject(new Error("text error")),
      } as unknown as Response;

      mockFetch.mockResolvedValue(mockBrokenResponse);

      const exit = await Effect.runPromiseExit(datasourceStacksApi.getTransaction(context, "500"));

      expect(exit).toBeTaggedError(
        new StacksApiResponseError({
          status: 400,
          statusText: "Bad Request",
          path: "/extended/v3/transactions/500",
          errorData: undefined,
        }),
      );
    });

    test("returns StacksApiUnexpectedError when request throws unexpected error", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const exit = await Effect.runPromiseExit(
        datasourceStacksApi.getTransaction(context, "network-error"),
      );

      expect(exit).toBeTaggedError({
        _tag: "StacksApiUnexpectedError",
        path: "/extended/v3/transactions/network-error",
      });
    });

    test("retries on 429 after retryAfter seconds and eventually succeeds", async () => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "2" }))
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = Effect.runPromise(datasourceStacksApi.getTransaction(context, "0xabc123"));

      await vi.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("returns StacksApiRateLimitError after exhausting retries on 429", async () => {
      vi.useFakeTimers();
      mockFetch.mockResolvedValue(
        jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "1" }),
      );

      const promise = Effect.runPromiseExit(
        datasourceStacksApi.getTransaction(context, "0xabc123"),
      );

      await vi.advanceTimersByTimeAsync(4000);

      const exit = await promise;

      expect(exit).toBeTaggedError(
        new StacksApiRateLimitError({
          path: "/extended/v3/transactions/0xabc123",
          retryAfter: 1,
        }),
      );
      expect(mockFetch).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    test("retries on 429 with retry-after 0 without delay", async () => {
      vi.useFakeTimers();
      mockFetch
        .mockResolvedValueOnce(jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "0" }))
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = Effect.runPromise(datasourceStacksApi.getTransaction(context, "0xabc123"));

      await vi.advanceTimersByTimeAsync(0);

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockFetch).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe("getBlock", () => {
    test("returns block data on 200 by hash", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe("https://api.hiro.so/extended/v2/blocks/0xabc123");
        return Promise.resolve(jsonResponse({ hash: "0xabc123", height: 123_456 }));
      });

      const result = await Effect.runPromise(datasourceStacksApi.getBlock(context, "0xabc123"));
      expect(result).toStrictEqual({ hash: "0xabc123", height: 123_456 });
    });

    test("returns block data on 200 by height", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe("https://api.hiro.so/extended/v2/blocks/123456");
        return Promise.resolve(jsonResponse({ hash: "0xabc123", height: 123_456 }));
      });

      const result = await Effect.runPromise(datasourceStacksApi.getBlock(context, 123_456));
      expect(result).toStrictEqual({ hash: "0xabc123", height: 123_456 });
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          "https://api.hiro.so/extended/v3/blocks/0xabc123/transactions?limit=20&cursor=100%3A0%3A0",
        );
        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getBlockTransactions(context, "0xabc123", {
          limit: 20,
          cursor: "100:0:0",
        }),
      );
      expect(result).toStrictEqual(mockResponse);
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe("https://api.hiro.so/extended/v3/blocks/123456/transactions");
        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getBlockTransactions(context, 123_456),
      );
      expect(result).toStrictEqual(mockResponse);
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe("https://api.hiro.so/extended/v3/transactions/0xtx123");
        return Promise.resolve(jsonResponse(mockTx));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransaction(context, "0xtx123"),
      );
      expect(result).toStrictEqual(mockTx);
    });

    test("includes optional fields when requested", async () => {
      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          "https://api.hiro.so/extended/v3/transactions/0xtx123?include=result%2Cpost_conditions",
        );
        return Promise.resolve(jsonResponse({ tx_id: "0xtx123" }));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransaction(context, "0xtx123", {
          include: ["result", "post_conditions"],
        }),
      );
      expect(result).toStrictEqual({ tx_id: "0xtx123" });
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe("https://api.hiro.so/extended/v1/tx/0xtx123");
        return Promise.resolve(jsonResponse(mockV1Tx));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getV1Transaction(context, "0xtx123"),
      );
      expect(result).toStrictEqual(mockV1Tx);
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          "https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xtx1&tx_id=0xtx2",
        );
        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransactionsBatch(context, ["0xtx1", "0xtx2"]),
      );
      expect(result).toStrictEqual(mockResponse);
    });

    test("returns empty results without a request when txIds is empty", async () => {
      const result = await Effect.runPromise(datasourceStacksApi.getTransactionsBatch(context, []));
      expect(result).toStrictEqual({ results: [] });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("returns StacksApiResponseError on 404", async () => {
      mockFetch.mockResolvedValue(jsonResponse({ error: "Not found" }, 404));

      const exit = await Effect.runPromiseExit(
        datasourceStacksApi.getTransactionsBatch(context, ["0xtx1"]),
      );

      expect(exit).toBeTaggedError(
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          `https://api.hiro.so/extended/v3/transactions/${txId}/events?limit=50`,
        );
        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransactionEvents(context, txId, { limit: 50 }),
      );
      expect(result).toStrictEqual(mockResponse);
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          `https://api.hiro.so/extended/v3/principals/${principal}/transactions?limit=50&cursor=curr_1`,
        );
        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getPrincipalTransactions(context, principal, {
          limit: 50,
          cursor: "curr_1",
        }),
      );
      expect(result).toStrictEqual(mockResponse);
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          `https://api.hiro.so/extended/v3/smart-contracts/${contractId}`,
        );
        return Promise.resolve(jsonResponse(mockContract));
      });

      const result = await Effect.runPromise(datasourceStacksApi.getContract(context, contractId));
      expect(result).toStrictEqual(mockContract);
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          `https://api.hiro.so/extended/v2/smart-contracts/${contractId}/logs?limit=100`,
        );
        return Promise.resolve(jsonResponse(mockLogs));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getContractLogs(context, contractId),
      );
      expect(result).toStrictEqual({
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
      });
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

      mockFetch.mockImplementation((url: unknown) => {
        expect(toUrlString(url)).toBe(
          "https://custom-stacks-node.example.com/extended/v3/transactions/0xtx123",
        );
        return Promise.resolve(jsonResponse({ tx_id: "0xtx123", block: { height: 123_456 } }));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransaction(customContext, "0xtx123"),
      );
      expect(result).toStrictEqual({ tx_id: "0xtx123", block: { height: 123_456 } });
    });

    test("sends x-api-key header when apiKey is provided", async () => {
      const apiKeyContext = {
        ...context,
        api: {
          apiKey: "my-test-api-key",
        },
      };

      mockFetch.mockImplementation((url: unknown, init: { headers: Record<string, string> }) => {
        expect(toUrlString(url)).toBe("https://api.hiro.so/extended/v3/transactions/0xtx123");
        expect(init.headers["x-api-key"]).toBe("my-test-api-key");
        return Promise.resolve(jsonResponse({ tx_id: "0xtx123", block: { height: 123_456 } }));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransaction(apiKeyContext, "0xtx123"),
      );
      expect(result).toStrictEqual({ tx_id: "0xtx123", block: { height: 123_456 } });
    });

    test("does not send x-api-key header when apiKey is not provided", async () => {
      mockFetch.mockImplementation((_url: unknown, init: { headers: Record<string, string> }) => {
        expect(init.headers["x-api-key"]).toBeUndefined();
        return Promise.resolve(jsonResponse({ tx_id: "0xtx123", block: { height: 123_456 } }));
      });

      const result = await Effect.runPromise(
        datasourceStacksApi.getTransaction(context, "0xtx123"),
      );
      expect(result).toStrictEqual({ tx_id: "0xtx123", block: { height: 123_456 } });
    });

    test("sends both x-api-key and content-type on POST requests", async () => {
      const apiKeyContext = {
        ...context,
        api: {
          baseUrl: "https://custom-stacks-node.example.com",
          apiKey: "my-test-api-key",
        },
      };

      mockFetch.mockImplementation(
        (url: unknown, init: { method: string; headers: Record<string, string>; body: string }) => {
          expect(toUrlString(url)).toBe(
            "https://custom-stacks-node.example.com/v2/contracts/call-read/SP123/contract/my-function",
          );
          expect(init.method).toBe("POST");
          expect(init.headers["x-api-key"]).toBe("my-test-api-key");
          expect(init.headers["content-type"]).toBe("application/json");
          expect(JSON.parse(init.body)).toMatchObject({
            sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
            arguments: [],
          });
          return Promise.resolve(jsonResponse({ okay: true, result: "0x01" }));
        },
      );

      const result = await Effect.runPromise(
        datasourceStacksApi.callReadFunction(apiKeyContext, "SP123.contract", "my-function"),
      );
      expect(result).toStrictEqual({ okay: true, result: "0x01" });
    });
  });

  describe("getStatus", () => {
    test("calls /extended endpoint and returns status response on 200", async () => {
      const mockResponse = {
        server_version: "stacks-node-api:v1.0.0",
        status: "ready",
        chain_tip: { block_height: 100 },
      };
      mockFetch.mockResolvedValue(jsonResponse(mockResponse));

      const result = await Effect.runPromise(datasourceStacksApi.getStatus(context));
      expect(result).toStrictEqual(mockResponse);
      expect(toUrlString(mockFetch.mock.calls[0][0])).toBe("https://api.hiro.so/extended");
      expect(mockFetch.mock.calls[0][1]).toMatchObject({ method: "GET" });
    });
  });
});
