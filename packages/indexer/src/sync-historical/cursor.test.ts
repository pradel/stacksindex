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
      body: mockBody({ limit: 1, offset: 0, total: 0, results: [] }),
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
        limit: 1,
        offset: 0,
        total: 3,
        results: [{ tx_id: "tx-1", event_count: 0 }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        offset: 0,
        total: 3,
        results: [
          { tx_id: "tx-1", event_count: 0 },
          { tx_id: "tx-2", event_count: 2 },
          { tx_id: "tx-3", event_count: 1 },
        ],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-2",
        block_height: 100,
        microblock_sequence: 2147483647,
        tx_index: 5,
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
    expect((result as any).value).toBe("100:2147483647:5:1");
  });

  test("skips transactions with no matching contract events", async () => {
    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 1,
        offset: 0,
        total: 2,
        results: [{ tx_id: "tx-1", event_count: 0 }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        offset: 0,
        total: 2,
        results: [
          { tx_id: "tx-1", event_count: 0 },
          { tx_id: "tx-2", event_count: 1 },
        ],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-2",
        block_height: 200,
        microblock_sequence: 0,
        tx_index: 3,
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
        limit: 1,
        offset: 0,
        total: 2,
        results: [{ tx_id: "tx-1", event_count: 0 }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        offset: 0,
        total: 2,
        results: [
          { tx_id: "tx-1", event_count: 0 },
          { tx_id: "tx-2", event_count: 1 },
        ],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-2",
        block_height: 200,
        microblock_sequence: 0,
        tx_index: 3,
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

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBeNull();
  });

  test("paginates across multiple pages from oldest to newest", async () => {
    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 1,
        offset: 0,
        total: 60,
        results: [{ tx_id: "tx-count", event_count: 0 }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        offset: 10,
        total: 60,
        results: Array.from({ length: 50 }, (_unused, index) => ({
          tx_id: `tx-${index + 11}`,
          event_count: 0,
        })),
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        limit: 50,
        offset: 0,
        total: 60,
        results: [
          { tx_id: "tx-1", event_count: 1 },
          ...Array.from({ length: 9 }, (_unused, index) => ({
            tx_id: `tx-${index + 2}`,
            event_count: 0,
          })),
        ],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-1",
        block_height: 1,
        microblock_sequence: 2147483647,
        tx_index: 0,
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
    expect((result as any).value).toBe("1:2147483647:0:0");
    expect(mockRequest).toHaveBeenCalledTimes(4);
  });

  test("returns error when getAddressTransactions fails", async () => {
    mockRequest.mockReturnValue({
      statusCode: 500,
      statusText: "Internal Server Error",
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
        limit: 1,
        offset: 0,
        total: 1,
        results: [{ tx_id: "tx-1", event_count: 1 }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 500,
      statusText: "Internal Server Error",
      body: mockBody({ error: "Tx API error" }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);
    expect(result.isErr()).toBe(true);
  });
});
