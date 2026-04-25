// oxlint-disable vitest/prefer-called-once, vitest/prefer-called-times

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, test, vi } from "vite-plus/test";

import type { HandlerEvent, Handlers } from "../lib/types.ts";
import { createLogger } from "../logger/index.ts";
import { createIndexing } from "./index.ts";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const mockDb = {} as unknown as NodePgDatabase;

const createMockEvent = (overrides: Partial<HandlerEvent> = {}): HandlerEvent => ({
  event_index: 0,
  event_type: "smart_contract_log",
  tx_id: "tx-1",
  contract_id: "SP123.token",
  topic: "print",
  value_hex: "0x01",
  value_repr: "(ok true)",
  block_height: 100,
  block_time: 1000,
  tx_index: 0,
  sender_address: "SP sender",
  ...overrides,
});

describe("indexing engine", () => {
  test("calls matching handler with event and context", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const handlers: Handlers = {
      "SP123.token": {
        smart_contract_log: [handler],
      },
    };

    const indexing = createIndexing({
      logger: createLogger({ level: 0 }),
      db: mockDb,
      handlers,
    });

    const event = createMockEvent();
    const result = await indexing.executeEvent(event);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(event, { db: mockDb });
  });

  test("calls multiple handlers for the same event type", async () => {
    const handlerA = vi.fn().mockResolvedValue(undefined);
    const handlerB = vi.fn().mockResolvedValue(undefined);
    const handlers: Handlers = {
      "SP123.token": {
        smart_contract_log: [handlerA, handlerB],
      },
    };

    const indexing = createIndexing({
      logger: createLogger({ level: 0 }),
      db: mockDb,
      handlers,
    });

    const event = createMockEvent();
    const result = await indexing.executeEvent(event);

    expect(result.isOk()).toBe(true);
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).toHaveBeenCalledTimes(1);
  });

  test("returns ok when no handlers match contract", async () => {
    const handlers: Handlers = {};

    const indexing = createIndexing({
      logger: createLogger({ level: 0 }),
      db: mockDb,
      handlers,
    });

    const event = createMockEvent();
    const result = await indexing.executeEvent(event);

    expect(result.isOk()).toBe(true);
  });

  test("returns ok when no handlers match event type", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const handlers: Handlers = {
      "SP123.token": {
        stx_transfer: [handler],
      },
    };

    const indexing = createIndexing({
      logger: createLogger({ level: 0 }),
      db: mockDb,
      handlers,
    });

    const event = createMockEvent({ event_type: "smart_contract_log" });
    const result = await indexing.executeEvent(event);

    expect(result.isOk()).toBe(true);
    expect(handler).not.toHaveBeenCalled();
  });

  test("returns err when handler throws", async () => {
    const error = new Error("Handler failed");
    const handler = vi.fn().mockRejectedValue(error);
    const handlers: Handlers = {
      "SP123.token": {
        smart_contract_log: [handler],
      },
    };

    const indexing = createIndexing({
      logger: createLogger({ level: 0 }),
      db: mockDb,
      handlers,
    });

    const event = createMockEvent();
    const result = await indexing.executeEvent(event);

    expect(result.isErr()).toBe(true);
    expect(
      result.match({
        ok: () => null,
        err: (errValue: Error) => errValue,
      }),
    ).toBe(error);
  });

  test("stops calling subsequent handlers after one throws", async () => {
    const handlerA = vi.fn().mockRejectedValue(new Error("Handler A failed"));
    const handlerB = vi.fn().mockResolvedValue(undefined);
    const handlers: Handlers = {
      "SP123.token": {
        smart_contract_log: [handlerA, handlerB],
      },
    };

    const indexing = createIndexing({
      logger: createLogger({ level: 0 }),
      db: mockDb,
      handlers,
    });

    const event = createMockEvent();
    const result = await indexing.executeEvent(event);

    expect(result.isErr()).toBe(true);
    expect(handlerA).toHaveBeenCalledTimes(1);
    expect(handlerB).not.toHaveBeenCalled();
  });
});
