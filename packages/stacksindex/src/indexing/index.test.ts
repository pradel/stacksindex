// oxlint-disable vitest/prefer-called-once, vitest/prefer-called-times

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, test, vi } from "vite-plus/test";

import type { HandlerEvent, Handlers } from "../lib/types.ts";
import { createLogger } from "../logger/index.ts";
import { createIndexing } from "./index.ts";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const mockDb = {} as unknown as NodePgDatabase;
const mockClient = {
  callReadOnly: vi.fn(),
};

const createMockEvent = (overrides: Partial<HandlerEvent> = {}): HandlerEvent => ({
  event_index: 0,
  event_type: "smart_contract_log",
  tx_id: "tx-1",
  contract_log: {
    contract_id: "SP123.token",
    topic: "print",
    value: { hex: "0x0102", repr: "(ok true)" },
  },
  block_height: 100,
  block_time: 1000,
  tx_index: 0,
  sender_address: "SP sender",
  decoded: undefined,
  ...overrides,
});

function createIndexingFor(
  handlers: Handlers,
  bounds: Parameters<typeof createIndexing>[0]["bounds"] = {},
) {
  return createIndexing({
    logger: createLogger({ level: 0 }),
    db: mockDb,
    client: mockClient,
    handlers,
    bounds,
  });
}

describe("indexing engine", () => {
  test("calls matching handler with event and context", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const indexing = createIndexingFor({ "SP123.token": handler });

    const event = createMockEvent();
    const result = await indexing.executeEvent(event);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event, { db: mockDb, client: mockClient });
  });

  test("returns ok when no handler matches contract", async () => {
    const indexing = createIndexingFor({});

    const result = await indexing.executeEvent(createMockEvent());

    expect(result.isOk()).toBe(true);
  });

  test("skips events below startBlock", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const indexing = createIndexingFor(
      { "SP123.token": handler },
      { "SP123.token": { startBlock: 150 } },
    );

    const result = await indexing.executeEvent(createMockEvent({ block_height: 100 }));

    expect(result.isOk()).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  test("dispatches events at or above startBlock", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const indexing = createIndexingFor(
      { "SP123.token": handler },
      { "SP123.token": { startBlock: 100 } },
    );

    const result = await indexing.executeEvent(createMockEvent({ block_height: 100 }));

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("skips events above endBlock", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const indexing = createIndexingFor(
      { "SP123.token": handler },
      { "SP123.token": { endBlock: 50 } },
    );

    const result = await indexing.executeEvent(createMockEvent({ block_height: 100 }));

    expect(result.isOk()).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  test("dispatches events within [startBlock, endBlock]", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const indexing = createIndexingFor(
      { "SP123.token": handler },
      { "SP123.token": { startBlock: 50, endBlock: 150 } },
    );

    const result = await indexing.executeEvent(createMockEvent({ block_height: 150 }));

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("bounds only apply to their own contract", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const indexing = createIndexingFor(
      { "SP123.token": handler, "SP456.other": handler },
      { "SP456.other": { endBlock: 10 } },
    );

    const result = await indexing.executeEvent(createMockEvent({ block_height: 9999 }));

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("passes decoded Clarity value through to the handler", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const indexing = createIndexingFor({ "SP123.token": handler });

    // 0x0100000000000000000000000000000005 encodes uint 5
    await indexing.executeEvent(
      createMockEvent({
        contract_log: {
          contract_id: "SP123.token",
          topic: "print",
          value: {
            hex: "0x0100000000000000000000000000000005",
            repr: "u5",
          },
        },
      }),
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("returns err when handler throws", async () => {
    const error = new Error("Handler failed");
    const handler = vi.fn().mockRejectedValue(error);
    const indexing = createIndexingFor({ "SP123.token": handler });

    const result = await indexing.executeEvent(createMockEvent());

    expect(result.isErr()).toBe(true);
  });
});
