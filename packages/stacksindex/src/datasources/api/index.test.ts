// oxlint-disable vitest/prefer-called-once
import { Effect, Layer, Predicate } from "effect";
import { HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http";
import { RateLimiter } from "effect/persistence";
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import {
  expectDecodeError,
  expectStatusError,
  expectTransportError,
} from "../../test-utils/http-errors.ts";
import {
  StacksClient,
  type StacksApiError,
  type StacksClientConfig,
  type StacksClientService,
} from "./index.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface BrokenResponseStub {
  status: number;
  statusText: string;
  headers: Headers;
  json: () => Promise<never>;
  text: () => Promise<never>;
}

const mockHandler = vi.fn();

const isJsonString = (value: JsonValue): value is string => typeof value === "string";

const toUrlString = (request: HttpClientRequest.HttpClientRequest): string =>
  Effect.runSync(HttpClientRequest.toWeb(request)).url;

const requestBodyText = (request: HttpClientRequest.HttpClientRequest): string => {
  if (!Predicate.isTagged(request.body, "Uint8Array") || request.body.text === undefined) {
    throw new Error("Expected a text request body");
  }

  return request.body.text;
};

const toStatusText = (status: number): string => {
  switch (status) {
    case 200:
      return "OK";
    case 400:
      return "Bad Request";
    case 404:
      return "Not Found";
    case 429:
      return "Too Many Requests";
    case 500:
      return "Internal Server Error";
    default:
      return String(status);
  }
};

const jsonResponse = (data: JsonValue, status = 200, headers: Record<string, string> = {}) =>
  new Response(isJsonString(data) ? data : JSON.stringify(data), {
    status,
    statusText: toStatusText(status),
    headers: {
      "content-type": isJsonString(data) ? "text/plain" : "application/json",
      ...headers,
    },
  });

const httpClient = HttpClient.make((request) =>
  Effect.tryPromise({
    try: async () => HttpClientResponse.fromWeb(request, await mockHandler(request)),
    catch: (cause) =>
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, cause }),
      }),
  }),
);

const testStacksClientLayer = (config: StacksClientConfig) =>
  Layer.effect(StacksClient, StacksClient.make(config)).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(HttpClient.HttpClient, httpClient),
        RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
      ),
    ),
  );

const context: StacksClientConfig = { baseUrl: "https://api.hiro.so" };

const withClient = <A>(
  f: (client: StacksClientService) => Effect.Effect<A, StacksApiError>,
  config: StacksClientConfig = context,
) =>
  Effect.gen(function* () {
    const client = yield* StacksClient;

    return yield* f(client);
  }).pipe(Effect.provide(testStacksClientLayer(config)));

const runRequest = <A>(
  f: (client: StacksClientService) => Effect.Effect<A, StacksApiError>,
  config: StacksClientConfig = context,
) => Effect.runPromise(withClient(f, config));

const runRequestExit = <A>(
  f: (client: StacksClientService) => Effect.Effect<A, StacksApiError>,
  config: StacksClientConfig = context,
) => Effect.runPromiseExit(withClient(f, config));

const runStacksClient = <A, E>(
  effect: Effect.Effect<A, E, StacksClient>,
  config: StacksClientConfig = context,
) => Effect.runPromise(effect.pipe(Effect.provide(testStacksClientLayer(config))));

describe("aPI DataSource", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe("_request", () => {
    test("returns data on 200", async () => {
      mockHandler.mockResolvedValue(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const result = await runRequest((client) => client.getTransaction("0xabc123"));

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
    });

    test("returns the response status error on 404", async () => {
      mockHandler.mockResolvedValue(jsonResponse({ error: "Not found" }, 404));

      const exit = await runRequestExit((client) => client.getTransaction("404"));

      await expectStatusError(exit, {
        status: 404,
        path: "/extended/v3/transactions/404",
        body: { error: "Not found" },
      });
    });

    test("returns the response status error on 500", async () => {
      mockHandler.mockResolvedValue(jsonResponse({ error: "Bad request" }, 400));

      const exit = await runRequestExit((client) => client.getTransaction("500"));

      await expectStatusError(exit, {
        status: 400,
        path: "/extended/v3/transactions/500",
        body: { error: "Bad request" },
      });
    });

    test("returns a decode error on invalid JSON", async () => {
      mockHandler.mockResolvedValue(
        new Response("invalid json {", {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
        }),
      );

      const exit = await runRequestExit((client) => client.getTransaction("parse-error"));

      const reason = expectDecodeError(exit, {
        path: "/extended/v3/transactions/parse-error",
      });

      expect(reason.cause).toBeInstanceOf(SyntaxError);
    });

    test("exposes the raw text body when the error response is not JSON", async () => {
      mockHandler.mockResolvedValue(
        new Response("Bad Request", {
          status: 400,
          statusText: "Bad Request",
          headers: { "content-type": "text/plain" },
        }),
      );

      const exit = await runRequestExit((client) => client.getTransaction("500"));

      await expectStatusError(exit, {
        status: 400,
        path: "/extended/v3/transactions/500",
        body: "Bad Request",
      });
    });

    test("fails when the error body cannot be read", async () => {
      const mockBrokenResponse: BrokenResponseStub = {
        status: 400,
        statusText: "Bad Request",
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.reject(new Error("parse error")),
        text: () => Promise.reject(new Error("text error")),
      };

      mockHandler.mockResolvedValue(mockBrokenResponse);

      const exit = await runRequestExit((client) => client.getTransaction("500"));

      await expectStatusError(exit, {
        status: 400,
        path: "/extended/v3/transactions/500",
      });
    });

    test("retries transport errors", async () => {
      vi.useFakeTimers();
      mockHandler.mockRejectedValue(new Error("Network error"));

      const promise = runRequestExit((client) => client.getTransaction("network-error"));

      await vi.runAllTimersAsync();

      const exit = await promise;

      expectTransportError(exit, {
        path: "/extended/v3/transactions/network-error",
        causeMessage: "Network error",
      });
      expect(mockHandler).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    test("retries on 429 after retryAfter seconds and eventually succeeds", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "2" }))
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = runRequest((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("returns the response status error after exhausting retries on 429", async () => {
      vi.useFakeTimers();
      mockHandler.mockResolvedValue(
        jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "1" }),
      );

      const promise = runRequestExit((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const exit = await promise;

      const response = await expectStatusError(exit, {
        status: 429,
        path: "/extended/v3/transactions/0xabc123",
        body: { error: "Rate limited" },
      });

      expect(response.headers["retry-after"]).toBe("1");
      expect(mockHandler).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    test("retries on 429 with retry-after 0 without delay", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "0" }))
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = runRequest((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("retries on 429 using an HTTP-date Retry-After", async () => {
      vi.useFakeTimers();
      const retryAt = new Date(Date.now() + 2000).toUTCString();
      mockHandler
        .mockResolvedValueOnce(
          jsonResponse({ error: "Rate limited" }, 429, { "retry-after": retryAt }),
        )
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = runRequest((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("falls back to one second for an invalid Retry-After", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(
          jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "not-a-date" }),
        )
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = runRequest((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("falls back to one second for a past HTTP-date Retry-After", async () => {
      vi.useFakeTimers();
      const retryAt = new Date(Date.now() - 60_000).toUTCString();
      mockHandler
        .mockResolvedValueOnce(
          jsonResponse({ error: "Rate limited" }, 429, { "retry-after": retryAt }),
        )
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = runRequest((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });

    test("retries on 5xx responses and eventually succeeds", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(jsonResponse({ error: "Server error" }, 500))
        .mockResolvedValueOnce(jsonResponse({ error: "Bad gateway" }, 502))
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = runRequest((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockHandler).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    test("returns the response status error after exhausting retries on 5xx", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(jsonResponse({ error: "Down" }, 503))
        .mockResolvedValueOnce(jsonResponse({ error: "Down" }, 503))
        .mockResolvedValueOnce(jsonResponse({ error: "Down" }, 503))
        .mockResolvedValueOnce(jsonResponse({ error: "Down" }, 503));

      const promise = runRequestExit((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const exit = await promise;

      await expectStatusError(exit, {
        status: 503,
        path: "/extended/v3/transactions/0xabc123",
        body: { error: "Down" },
      });
      expect(mockHandler).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });

    test("retries on 408 and 504 responses", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(jsonResponse({ error: "Timeout" }, 408))
        .mockResolvedValueOnce(jsonResponse({ error: "Gateway timeout" }, 504))
        .mockResolvedValueOnce(jsonResponse({ hash: "0xabc123", block_height: 123_456 }));

      const promise = runRequest((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ hash: "0xabc123", block_height: 123_456 });
      expect(mockHandler).toHaveBeenCalledTimes(3);

      vi.useRealTimers();
    });

    test("retries POST read-only calls", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(jsonResponse({ error: "Rate limited" }, 429, { "retry-after": "1" }))
        .mockResolvedValueOnce(jsonResponse({ okay: true, result: "0x01" }));

      const promise = runRequest((client) =>
        client.callReadFunction("SP123.contract", "my-function"),
      );

      await vi.runAllTimersAsync();

      const result = await promise;

      expect(result).toStrictEqual({ okay: true, result: "0x01" });
      expect(mockHandler).toHaveBeenCalledTimes(2);
      expect(mockHandler.mock.calls[1]?.[0]?.method).toBe("POST");

      vi.useRealTimers();
    });

    test("returns null for an empty 2xx body", async () => {
      mockHandler.mockResolvedValue(
        new Response("", { status: 200, headers: { "content-type": "application/json" } }),
      );

      const result = await runRequest((client) => client.getTransaction("0xabc123"));

      expect(result).toBeNull();
    });

    test("retries aborted requests", async () => {
      vi.useFakeTimers();
      mockHandler.mockRejectedValue(new DOMException("The operation was aborted", "AbortError"));

      const promise = runRequestExit((client) => client.getTransaction("0xabc123"));

      await vi.runAllTimersAsync();

      const exit = await promise;

      expectTransportError(exit, {
        path: "/extended/v3/transactions/0xabc123",
        causeMessage: "The operation was aborted",
      });
      expect(mockHandler).toHaveBeenCalledTimes(4);

      vi.useRealTimers();
    });
  });

  describe("getBlock", () => {
    test("returns block data on 200 by hash", async () => {
      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe("https://api.hiro.so/extended/v2/blocks/0xabc123");

        return Promise.resolve(jsonResponse({ hash: "0xabc123", height: 123_456 }));
      });

      const result = await runRequest((client) => client.getBlock("0xabc123"));
      expect(result).toStrictEqual({ hash: "0xabc123", height: 123_456 });
    });

    test("returns block data on 200 by height", async () => {
      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe("https://api.hiro.so/extended/v2/blocks/123456");

        return Promise.resolve(jsonResponse({ hash: "0xabc123", height: 123_456 }));
      });

      const result = await runRequest((client) => client.getBlock(123_456));
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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          "https://api.hiro.so/extended/v3/blocks/0xabc123/transactions?limit=20&cursor=100%3A0%3A0",
        );

        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await runRequest((client) =>
        client.getBlockTransactions("0xabc123", {
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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          "https://api.hiro.so/extended/v3/blocks/123456/transactions",
        );

        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await runRequest((client) => client.getBlockTransactions(123_456));

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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe("https://api.hiro.so/extended/v3/transactions/0xtx123");

        return Promise.resolve(jsonResponse(mockTx));
      });

      const result = await runRequest((client) => client.getTransaction("0xtx123"));

      expect(result).toStrictEqual(mockTx);
    });

    test("includes optional fields when requested", async () => {
      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          "https://api.hiro.so/extended/v3/transactions/0xtx123?include=result%2Cpost_conditions",
        );

        return Promise.resolve(jsonResponse({ tx_id: "0xtx123" }));
      });

      const result = await runRequest((client) =>
        client.getTransaction("0xtx123", {
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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe("https://api.hiro.so/extended/v1/tx/0xtx123");

        return Promise.resolve(jsonResponse(mockV1Tx));
      });

      const result = await runRequest((client) => client.getV1Transaction("0xtx123"));

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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          "https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xtx1&tx_id=0xtx2",
        );

        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await runRequest((client) => client.getTransactionsBatch(["0xtx1", "0xtx2"]));

      expect(result).toStrictEqual(mockResponse);
    });

    test("returns empty results without a request when txIds is empty", async () => {
      const result = await runRequest((client) => client.getTransactionsBatch([]));
      expect(result).toStrictEqual({ results: [] });
      expect(mockHandler).not.toHaveBeenCalled();
    });

    test("returns the response status error on 404", async () => {
      mockHandler.mockResolvedValue(jsonResponse({ error: "Not found" }, 404));

      const exit = await runRequestExit((client) => client.getTransactionsBatch(["0xtx1"]));

      await expectStatusError(exit, {
        status: 404,
        path: "/extended/v3/transactions/batch",
        body: { error: "Not found" },
      });
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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          `https://api.hiro.so/extended/v3/transactions/${txId}/events?limit=50`,
        );

        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await runRequest((client) => client.getTransactionEvents(txId, { limit: 50 }));

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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          `https://api.hiro.so/extended/v3/principals/${principal}/transactions?limit=50&cursor=curr_1`,
        );

        return Promise.resolve(jsonResponse(mockResponse));
      });

      const result = await runRequest((client) =>
        client.getPrincipalTransactions(principal, {
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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          `https://api.hiro.so/extended/v3/smart-contracts/${contractId}`,
        );

        return Promise.resolve(jsonResponse(mockContract));
      });

      const result = await runRequest((client) => client.getContract(contractId));
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

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          `https://api.hiro.so/extended/v2/smart-contracts/${contractId}/logs?limit=100`,
        );

        return Promise.resolve(jsonResponse(mockLogs));
      });

      const result = await runRequest((client) => client.getContractLogs(contractId));

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
      const customContext: StacksClientConfig = {
        ...context,
        baseUrl: "https://custom-stacks-node.example.com",
      };

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          "https://custom-stacks-node.example.com/extended/v3/transactions/0xtx123",
        );

        return Promise.resolve(jsonResponse({ tx_id: "0xtx123", block: { height: 123_456 } }));
      });

      const result = await runRequest((client) => client.getTransaction("0xtx123"), customContext);

      expect(result).toStrictEqual({ tx_id: "0xtx123", block: { height: 123_456 } });
    });

    test("sends x-api-key header when apiKey is provided", async () => {
      const apiKeyContext: StacksClientConfig = {
        ...context,
        apiKey: "my-test-api-key",
      };

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe("https://api.hiro.so/extended/v3/transactions/0xtx123");
        expect(request.headers["x-api-key"]).toBe("my-test-api-key");

        return Promise.resolve(jsonResponse({ tx_id: "0xtx123", block: { height: 123_456 } }));
      });

      const result = await runRequest((client) => client.getTransaction("0xtx123"), apiKeyContext);

      expect(result).toStrictEqual({ tx_id: "0xtx123", block: { height: 123_456 } });
    });

    test("does not send x-api-key header when apiKey is not provided", async () => {
      mockHandler.mockImplementation((request) => {
        expect(request.headers["x-api-key"]).toBeUndefined();

        return Promise.resolve(jsonResponse({ tx_id: "0xtx123", block: { height: 123_456 } }));
      });

      const result = await runRequest((client) => client.getTransaction("0xtx123"));

      expect(result).toStrictEqual({ tx_id: "0xtx123", block: { height: 123_456 } });
    });

    test("sends both x-api-key and content-type on POST requests", async () => {
      const apiKeyContext: StacksClientConfig = {
        ...context,
        baseUrl: "https://custom-stacks-node.example.com",
        apiKey: "my-test-api-key",
      };

      mockHandler.mockImplementation((request) => {
        expect(toUrlString(request)).toBe(
          "https://custom-stacks-node.example.com/v2/contracts/call-read/SP123/contract/my-function",
        );
        expect(request.method).toBe("POST");
        expect(request.headers["x-api-key"]).toBe("my-test-api-key");
        expect(request.headers["content-type"]).toBe("application/json");
        expect(JSON.parse(requestBodyText(request))).toMatchObject({
          sender: "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM",
          arguments: [],
        });

        return Promise.resolve(jsonResponse({ okay: true, result: "0x01" }));
      });

      const result = await runRequest(
        (client) => client.callReadFunction("SP123.contract", "my-function"),
        apiKeyContext,
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

      mockHandler.mockResolvedValue(jsonResponse(mockResponse));

      const result = await runRequest((client) => client.getStatus());
      expect(result).toStrictEqual(mockResponse);
      expect(toUrlString(mockHandler.mock.calls[0][0])).toBe("https://api.hiro.so/extended");
      expect(mockHandler.mock.calls[0][0]?.method).toBe("GET");
    });
  });

  describe("stacks client service", () => {
    const getStatusProgram = Effect.gen(function* getStatusProgram() {
      const client = yield* StacksClient;

      return yield* client.getStatus();
    });

    const twoStatusProgram = Effect.gen(function* twoStatusProgram() {
      const client = yield* StacksClient;

      yield* client.getStatus();

      return yield* client.getStatus();
    });

    test("forwards baseUrl and apiKey from config", async () => {
      mockHandler.mockResolvedValue(jsonResponse({ status: "ready" }));

      const result = await runStacksClient(getStatusProgram, {
        baseUrl: "https://custom-stacks-node.example.com",
        apiKey: "secret-key",
      });

      expect(result).toStrictEqual({ status: "ready" });
      expect(toUrlString(mockHandler.mock.calls[0][0])).toBe(
        "https://custom-stacks-node.example.com/extended",
      );
      expect(mockHandler.mock.calls[0][0]?.headers["x-api-key"]).toBe("secret-key");
    });

    test("throttles requests from x-ratelimit headers", async () => {
      vi.useFakeTimers();
      mockHandler
        .mockResolvedValueOnce(
          jsonResponse({ status: "ready" }, 200, {
            "x-ratelimit-limit": "1",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1",
          }),
        )
        .mockResolvedValueOnce(jsonResponse({ status: "ready" }));

      const promise = runStacksClient(twoStatusProgram);

      await vi.runAllTimersAsync();

      await promise;

      expect(mockHandler).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });
});
