// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-return
// oxlint-disable typescript/no-explicit-any
// oxlint-disable jest/no-conditional-in-test
// oxlint-disable vitest/no-conditional-in-test
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { StacksApiResponseError } from "../datasources/api/errors.ts";
import { createLogger } from "../logger/index.ts";
import {
  buildLogsCursor,
  buildTransactionCursor,
  createHistoricalSync,
  parseLogsCursor,
  parseTransactionCursor,
} from "./index.ts";

const mockRequest = vi.hoisted(() => vi.fn());

vi.mock("undici", () => ({
  request: (url: string, init?: any) => {
    try {
      return mockRequest(url, init);
    } catch (err: any) {
      if (typeof url === "string" && url.includes("/extended/v1/tx/")) {
        const txId = url.split("/").pop()?.split("?")[0] ?? "tx-1";
        return {
          statusCode: 200,
          body: {
            json: () =>
              Promise.resolve({
                tx_id: txId,
                block_height: 100,
                tx_index: 0,
                microblock_sequence: 0,
              }),
          },
        };
      }
      throw err;
    }
  },
}));

const context = {
  logger: createLogger({ level: 0 }),
};

const contractId = "SP123.token";

const mockBody = (data: unknown) => ({
  json: () => Promise.resolve(data),
});

describe("getContractEventsFirstCursor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  test("returns error when getContract fails", async () => {
    mockRequest.mockReturnValue({
      statusCode: 404,
      statusText: "Not Found",
      body: mockBody({ error: "Contract not found" }),
      headers: { "content-type": "application/json" },
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result).toBeBetterErr(
      new StacksApiResponseError({
        status: 404,
        statusText: "Not Found",
        path: `/extended/v3/smart-contracts/${contractId}`,
        errorData: { error: "Contract not found" },
      }),
    );
  });

  test("returns null when contract has no transactions", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 0,
            cursor: { next: null, previous: null, current: "" },
            results: [],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBeNull();
  });

  test("returns cursor for first contract event in oldest transaction", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 3,
            cursor: { next: null, previous: null, current: "curr" },
            results: [
              { transaction: { tx_id: "tx-3", block: { height: 100, tx_index: 2 } } },
              { transaction: { tx_id: "tx-2", block: { height: 100, tx_index: 1 } } },
              { transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 2,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              { event_index: 0, type: "stx_asset" },
              {
                event_index: 2,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 2,
            block: {
              height: 100,
              tx_index: 5,
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("100:0:5:2");
  });

  test("skips transactions with no matching contract events", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 200 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 2,
            cursor: { next: null, previous: null, current: "curr" },
            results: [
              { transaction: { tx_id: "tx-2", block: { height: 200, tx_index: 1 } } },
              { transaction: { tx_id: "tx-1", block: { height: 200, tx_index: 0 } } },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: "SP456.other-contract",
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            block: {
              height: 200,
              tx_index: 0,
            },
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-2/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 1,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-2")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-2",
            event_count: 1,
            block: {
              height: 200,
              tx_index: 1,
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("200:0:1:1");
  });

  test("returns null when all transactions have event_count 0", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 200 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 2,
            cursor: { next: null, previous: null, current: "curr" },
            results: [
              { transaction: { tx_id: "tx-2", block: { height: 201, tx_index: 0 } } },
              { transaction: { tx_id: "tx-1", block: { height: 200, tx_index: 3 } } },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 0,
            block: {
              height: 200,
              tx_index: 3,
            },
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-2")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-2",
            event_count: 0,
            block: {
              height: 201,
              tx_index: 0,
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBeNull();
  });

  test("paginates forward across multiple pages from oldest to newest", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 1 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (
        url.includes(`/extended/v3/principals/${contractId}/transactions?limit=50&cursor=1%3A0%3A0`)
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 60,
            cursor: { next: null, previous: "page_2_cursor", current: "1:0:0" },
            results: [{ transaction: { tx_id: "tx-none", block: { height: 1, tx_index: 0 } } }],
          }),
        };
      }
      if (
        url.includes(
          `/extended/v3/principals/${contractId}/transactions?limit=50&cursor=page_2_cursor`,
        )
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 60,
            cursor: { next: "1:0:0", previous: null, current: "page_2_cursor" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 2, tx_index: 0 } } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-none")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-none",
            event_count: 0,
            block: {
              height: 1,
              tx_index: 0,
            },
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            block: {
              height: 2,
              tx_index: 0,
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("2:0:0:0");
  });

  test("returns error when getPrincipalTransactions fails", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 400,
          statusText: "Bad Request",
          body: mockBody({ error: "API error" }),
          headers: { "content-type": "application/json" },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result).toBeBetterErr(
      new StacksApiResponseError({
        status: 400,
        statusText: "Bad Request",
        path: `/extended/v3/principals/${contractId}/transactions`,
        errorData: { error: "API error" },
      }),
    );
  });

  test("returns error when getTransaction fails", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 400,
          statusText: "Bad Request",
          body: mockBody({ error: "Tx API error" }),
          headers: { "content-type": "application/json" },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);
    expect(result).toBeBetterErr(
      new StacksApiResponseError({
        status: 400,
        statusText: "Bad Request",
        path: "/extended/v3/transactions/tx-1",
        errorData: { error: "Tx API error" },
      }),
    );
  });

  test("returns error when getV1Transaction fails", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [{ transaction: { tx_id: "tx-1", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            event_count: 1,
            block: { height: 100, tx_index: 0 },
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-1")) {
        return {
          statusCode: 400,
          statusText: "Bad Request",
          body: mockBody({ error: "v1 tx failed" }),
          headers: { "content-type": "application/json" },
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);
    expect(result).toBeBetterErr(
      new StacksApiResponseError({
        status: 400,
        statusText: "Bad Request",
        path: "/extended/v1/tx/tx-1",
        errorData: { error: "v1 tx failed" },
      }),
    );
  });

  test("constructs cursor with anchor block microblock_sequence 2147483647", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 132118 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [
              { transaction: { tx_id: "tx-anchor", block: { height: 132191, tx_index: 6 } } },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-anchor/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-anchor")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-anchor",
            event_count: 1,
            block: { height: 132191, tx_index: 6 },
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-anchor")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-anchor",
            block_height: 132191,
            tx_index: 6,
            microblock_sequence: 2147483647,
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("132191:2147483647:6:0");
  });

  test("constructs cursor with microblock sequence number", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 147278 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "curr" },
            results: [
              { transaction: { tx_id: "tx-mb", block: { height: 147279, tx_index: 161 } } },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-mb/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 3,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-mb")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-mb",
            event_count: 1,
            block: { height: 147279, tx_index: 161 },
          }),
        };
      }
      if (url.includes("/extended/v1/tx/tx-mb")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-mb",
            block_height: 147279,
            tx_index: 161,
            microblock_sequence: 14,
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("147279:14:161:3");
  });

  test("uses startBlock when startBlock is greater than deployment block height", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (
        url.includes(
          `/extended/v3/principals/${contractId}/transactions?limit=50&cursor=150%3A0%3A0`,
        )
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "150:0:0" },
            results: [{ transaction: { tx_id: "tx-150", block: { height: 150, tx_index: 0 } } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-150/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-150")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-150",
            event_count: 1,
            block: {
              height: 150,
              tx_index: 0,
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId, { startBlock: 150 });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("150:0:0:0");
  });

  test("uses deployment block height when startBlock is less than deployment block height", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v3/smart-contracts/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block: { height: 100 },
            tx_id: "tx-deploy",
          }),
        };
      }
      if (
        url.includes(
          `/extended/v3/principals/${contractId}/transactions?limit=50&cursor=100%3A0%3A0`,
        )
      ) {
        return {
          statusCode: 200,
          body: mockBody({
            limit: 50,
            total: 1,
            cursor: { next: null, previous: null, current: "100:0:0" },
            results: [{ transaction: { tx_id: "tx-100", block: { height: 100, tx_index: 0 } } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-100/events")) {
        return {
          statusCode: 200,
          body: mockBody({
            total: 1,
            limit: 50,
            cursor: { next: null, previous: null, current: "0" },
            results: [
              {
                event_index: 0,
                type: "contract_log",
                contract_log: {
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-100")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-100",
            event_count: 1,
            block: {
              height: 100,
              tx_index: 0,
            },
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId, { startBlock: 50 });

    expect(result.isOk()).toBe(true);
    expect(result.unwrap()).toBe("100:0:0:0");
  });
});

describe("cursor utilities", () => {
  test("builds and parses logs cursor", () => {
    const cursor = buildLogsCursor({
      blockHeight: 123,
      microblockSequence: 0,
      txIndex: 4,
      eventIndex: 2,
    });
    expect(cursor).toBe("123:0:4:2");

    const parsed = parseLogsCursor("123:0:4:2");
    expect(parsed).toStrictEqual({
      blockHeight: 123,
      microblockSequence: 0,
      txIndex: 4,
      eventIndex: 2,
    });
  });

  test("builds and parses transaction cursor", () => {
    const cursor = buildTransactionCursor({
      blockHeight: 123,
      microblockSequence: 0,
      txIndex: 4,
    });
    expect(cursor).toBe("123:0:4");

    const parsed = parseTransactionCursor("123:0:4");
    expect(parsed).toStrictEqual({
      blockHeight: 123,
      microblockSequence: 0,
      txIndex: 4,
    });
  });
});
