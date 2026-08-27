// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-explicit-any
// oxlint-disable jest/no-conditional-in-test
// oxlint-disable vitest/no-conditional-in-test
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

  test("returns error when getContract fails", async () => {
    mockRequest.mockReturnValue({
      statusCode: 404,
      statusText: "Not Found",
      body: mockBody({ error: "Contract not found" }),
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isErr()).toBe(true);
  });

  test("returns null when contract has no transactions", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
              { transaction: { tx_id: "tx-3" } },
              { transaction: { tx_id: "tx-2" } },
              { transaction: { tx_id: "tx-1" } },
            ],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
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
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("100:0:5:1");
  });

  test("skips transactions with no matching contract events", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 200,
            tx_id: "tx-deploy",
            canonical: true,
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
            results: [{ transaction: { tx_id: "tx-2" } }, { transaction: { tx_id: "tx-1" } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
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
                  contract_id: contractId,
                  topic: "print",
                  value: { hex: "", repr: "" },
                },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("200:0:3:0");
  });

  test("returns null when no transactions contain contract events", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 200,
            tx_id: "tx-deploy",
            canonical: true,
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
            results: [{ transaction: { tx_id: "tx-2" } }, { transaction: { tx_id: "tx-1" } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
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
        };
      }
      if (url.includes("/extended/v3/transactions/tx-2")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-2",
            block: {
              height: 201,
              tx_index: 0,
            },
            events: [],
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
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 1,
            tx_id: "tx-deploy",
            canonical: true,
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
            results: [{ transaction: { tx_id: "tx-none" } }],
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
            results: [{ transaction: { tx_id: "tx-1" } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-none")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-none",
            block: {
              height: 1,
              tx_index: 0,
            },
            events: [],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 200,
          body: mockBody({
            tx_id: "tx-1",
            block: {
              height: 2,
              tx_index: 0,
            },
            events: [
              {
                event_index: 0,
                event_type: "smart_contract_log",
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
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isOk()).toBe(true);
    expect((result as any).value).toBe("2:0:0:0");
  });

  test("returns error when getPrincipalTransactions fails", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
          }),
        };
      }
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        return {
          statusCode: 400,
          statusText: "Bad Request",
          body: mockBody({ error: "API error" }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);

    expect(result.isErr()).toBe(true);
  });

  test("returns error when getTransaction fails", async () => {
    mockRequest.mockImplementation((url: string) => {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: mockBody({
            contract_id: contractId,
            block_height: 100,
            tx_id: "tx-deploy",
            canonical: true,
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
            results: [{ transaction: { tx_id: "tx-1" } }],
          }),
        };
      }
      if (url.includes("/extended/v3/transactions/tx-1")) {
        return {
          statusCode: 400,
          statusText: "Bad Request",
          body: mockBody({ error: "Tx API error" }),
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    const sync = createHistoricalSync(context);
    const result = await sync.getContractEventsFirstCursor(contractId);
    expect(result.isErr()).toBe(true);
  });
});
