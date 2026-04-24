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

describe("run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  test("skips sync when no first cursor exists", async () => {
    mockRequest.mockReturnValue({
      statusCode: 200,
      body: mockBody({ limit: 1, offset: 0, total: 0, results: [] }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.run(contractId);

    expect(result.isOk()).toBe(true);
  });

  test("fetches and paginates events from first cursor", async () => {
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
      statusCode: 200,
      body: mockBody({
        limit: 50,
        offset: 0,
        total: 1,
        results: [{ tx_id: "tx-1", event_count: 1 }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-1",
        block_height: 100,
        microblock_sequence: 0,
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

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        results: [
          {
            tx_id: "tx-1",
            event_index: 0,
            event_type: "smart_contract_log",
            contract_id: contractId,
            topic: "print",
            value: { hex: "", repr: "" },
          },
        ],
        limit: 100,
        offset: 0,
        total: 2,
        next_cursor: "cursor-2",
        prev_cursor: null,
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        results: [
          {
            tx_id: "tx-2",
            event_index: 0,
            event_type: "smart_contract_log",
            contract_id: contractId,
            topic: "print",
            value: { hex: "", repr: "" },
          },
        ],
        limit: 100,
        offset: 0,
        total: 2,
        next_cursor: null,
        prev_cursor: "cursor-1",
      }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.run(contractId);

    expect(result.isOk()).toBe(true);
    expect(mockRequest).toHaveBeenCalledTimes(5);
  });

  test("returns error when getContractLogs fails", async () => {
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
      statusCode: 200,
      body: mockBody({
        limit: 50,
        offset: 0,
        total: 1,
        results: [{ tx_id: "tx-1", event_count: 1 }],
      }),
    });

    mockRequest.mockReturnValueOnce({
      statusCode: 200,
      body: mockBody({
        tx_id: "tx-1",
        block_height: 100,
        microblock_sequence: 0,
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

    mockRequest.mockReturnValueOnce({
      statusCode: 500,
      statusText: "Internal Server Error",
      body: mockBody({ error: "Logs API error" }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.run(contractId);

    expect(result.isErr()).toBe(true);
  });
});
