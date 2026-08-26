// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-explicit-any
import { afterAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createLogger } from "../logger/index.ts";
import { createHistoricalSync } from "./index.ts";

const mockRequest = vi.hoisted(() => vi.fn());

// oxlint-disable-next-line jest/no-untyped-mock-factory
vi.mock("undici", () => ({
  request: mockRequest,
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

  test("returns null when contract has no transactions", async () => {
    mockRequest.mockReturnValue({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        total: 0,
        cursor: { next: null, previous: null, current: "" },
        results: [],
      }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBeNull();
  });

  test("returns cursor for first contract event in oldest transaction", async () => {
    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        total: 3,
        cursor: { next: null, previous: null, current: "curr" },
        results: [
          { transaction: { tx_id: "tx-3" } },
          { transaction: { tx_id: "tx-2" } },
          { transaction: { tx_id: "tx-1" } },
        ],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-1",
        block: {
          height: 100,
          tx_index: 5,
        },
        events: [
          {
            event_index: 0,
            event_type: "stx_asset",
          },
          {
            event_index: 1,
            event_type: "smart_contract_log",
            contract_log: { contract_id: contractId, topic: "print", value: { hex: "", repr: "" } },
          },
        ],
      }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("100:0:5:1");
  });

  test("skips transactions with no matching contract events", async () => {
    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        total: 2,
        cursor: { next: null, previous: null, current: "curr" },
        results: [{ transaction: { tx_id: "tx-2" } }, { transaction: { tx_id: "tx-1" } }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-1",
        block: {
          height: 200,
          tx_index: 3,
        },
        events: [
          {
            event_index: 0,
            event_type: "smart_contract_log",
            contract_log: { contract_id: contractId, topic: "print", value: { hex: "", repr: "" } },
          },
        ],
      }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("200:0:3:0");
  });

  test("returns null when no transactions contain contract events", async () => {
    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        total: 2,
        cursor: { next: null, previous: null, current: "curr" },
        results: [{ transaction: { tx_id: "tx-2" } }, { transaction: { tx_id: "tx-1" } }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-1",
        block: {
          height: 200,
          tx_index: 3,
        },
        events: [
          {
            event_index: 0,
            event_type: "smart_contract_log",
            contract_log: {
              contract_id: "SP456.other",
              topic: "print",
              value: { hex: "", repr: "" },
            },
          },
        ],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-2",
        block: {
          height: 201,
          tx_index: 0,
        },
        events: [],
      }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBeNull();
  });

  test("paginates across multiple pages from oldest to newest", async () => {
    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        total: 60,
        cursor: { next: "cursor_page_2", previous: null, current: "page_1" },
        results: Array.from({ length: 50 }, (_unused, index) => ({
          transaction: { tx_id: `tx-${index + 11}` },
        })),
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        total: 60,
        cursor: { next: null, previous: "page_1", current: "page_2" },
        results: [
          ...Array.from({ length: 9 }, (_unused, index) => ({
            transaction: { tx_id: `tx-${index + 2}` },
          })),
          { transaction: { tx_id: "tx-1" } },
        ],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-1",
        block: {
          height: 1,
          tx_index: 0,
        },
        events: [
          {
            event_index: 0,
            event_type: "smart_contract_log",
            contract_log: { contract_id: contractId, topic: "print", value: { hex: "", repr: "" } },
          },
        ],
      }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("1:0:0:0");
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });

  test("returns error when getPrincipalTransactions fails", async () => {
    mockRequest.mockReturnValue({
      statusCode: 400,
      statusText: "Bad Request",
      body: mockBody({ error: "API error" }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isErr()).toBe(true);
  });

  test("returns error when getTransaction fails", async () => {
    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        total: 1,
        cursor: { next: null, previous: null, current: "curr" },
        results: [{ transaction: { tx_id: "tx-1" } }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 400,
      statusText: "Bad Request",
      body: mockBody({ error: "Tx API error" }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);
    expect(result.isErr()).toBe(true);
  });
});
