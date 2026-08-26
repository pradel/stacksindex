// oxlint-disable typescript/no-unsafe-assignment
// oxlint-disable vitest/prefer-called-once, vitest/prefer-called-times

import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { describe, expect, test, vi } from "vite-plus/test";

import { datasourceStacksApi } from "../datasources/api/index.ts";
import type { HandlerContext, HandlerEvent, Handlers } from "../lib/types.ts";
import { createLogger } from "../logger/index.ts";
import { createIndexing } from "./index.ts";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const mockDb = {} as unknown as NodePgDatabase;

const createMockEvent = (overrides: Partial<HandlerEvent> = {}): HandlerEvent => ({
  event_index: 0,
  event_type: "smart_contract_log",
  tx_id: "tx-1",
  contract_log: {
    contract_id: "SP123.token",
    topic: "print",
    value: { hex: "0x01", repr: "(ok true)" },
  },
  block_height: 100,
  block_time: 1000,
  tx_index: 0,
  sender_address: "SP sender",
  ...overrides,
});

describe("indexing engine", () => {
  test("calls matching handler with event and context containing db and client", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const handlers: Handlers = {
      "SP123.token": handler,
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
    expect(handler).toHaveBeenCalledWith(
      event,
      expect.objectContaining({
        db: mockDb,
        client: expect.objectContaining({
          callReadOnly: expect.any(Function),
        }),
      }),
    );
  });

  test("client.callReadOnly injects event block_height as tip and forwards api config", async () => {
    const callReadSpy = vi
      .spyOn(datasourceStacksApi, "callReadFunction")
      .mockResolvedValue(Result.ok({ okay: true, result: "0x01" }));

    const logger = createLogger({ level: 0 });
    const api = { baseUrl: "https://custom.api", apiKey: "secret-key" };

    const handler = vi.fn().mockImplementation(async (_event, ctx: HandlerContext) => {
      // Call without explicit tip - should inject event.block_height
      await ctx.client.callReadOnly("SP123.contract", "get-something", {
        args: ["0x01"],
        sender: "ST123",
      });

      // Call with explicit options.tip - should use explicit tip
      await ctx.client.callReadOnly("SP123.contract", "get-something", {
        tip: 99999,
      });

      // Call without options - should default tip to event.block_height
      await ctx.client.callReadOnly("SP123.contract", "get-something");
    });

    const handlers: Handlers = {
      "SP123.token": handler,
    };

    const indexing = createIndexing({
      logger,
      db: mockDb,
      handlers,
      api,
    });

    const event = createMockEvent({ block_height: 54321 });
    const result = await indexing.executeEvent(event);

    expect(result.isOk()).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);

    expect(callReadSpy).toHaveBeenNthCalledWith(
      1,
      { logger, api },
      "SP123.contract",
      "get-something",
      {
        args: ["0x01"],
        sender: "ST123",
        tip: 54321,
      },
    );

    expect(callReadSpy).toHaveBeenNthCalledWith(
      2,
      { logger, api },
      "SP123.contract",
      "get-something",
      {
        tip: 99999,
      },
    );

    expect(callReadSpy).toHaveBeenNthCalledWith(
      3,
      { logger, api },
      "SP123.contract",
      "get-something",
      {
        tip: 54321,
      },
    );

    callReadSpy.mockRestore();
  });

  test("returns ok when no handler matches contract", async () => {
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

  test("returns err when handler throws", async () => {
    const error = new Error("Handler failed");
    const handler = vi.fn().mockRejectedValue(error);
    const handlers: Handlers = {
      "SP123.token": handler,
    };

    const indexing = createIndexing({
      logger: createLogger({ level: 0 }),
      db: mockDb,
      handlers,
    });

    const event = createMockEvent();
    const result = await indexing.executeEvent(event);

    expect(result.isErr()).toBe(true);
  });
});
