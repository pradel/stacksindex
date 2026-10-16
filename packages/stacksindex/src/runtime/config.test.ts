import { Effect, Exit } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { ConfigurationError } from "../lib/errors.ts";
import { resolveIndexerConfig } from "./config.ts";

describe("indexer config", () => {
  test("polling does not need a websocket URL from a malformed api.baseUrl", async () => {
    const config = await Effect.runPromise(resolveIndexerConfig({ api: { baseUrl: "not a url" } }));

    expect(config.live).toStrictEqual({ transport: "polling", pollingInterval: 5000 });
  });

  test("websocket fails with ConfigurationError when its URL cannot be derived", async () => {
    const exit = await Effect.runPromiseExit(
      resolveIndexerConfig({ api: { baseUrl: "not a url" }, live: { transport: "websocket" } }),
    );

    expect(exit).toStrictEqual(
      Exit.fail(
        new ConfigurationError({
          message:
            'Cannot derive a websocket URL from api.baseUrl "not a url"; set live.webSocketUrl.',
        }),
      ),
    );
  });

  test("websocket derives its URL from api.baseUrl", async () => {
    const config = await Effect.runPromise(
      resolveIndexerConfig({
        api: { baseUrl: "http://localhost:3999/" },
        live: { transport: "websocket" },
      }),
    );

    expect(config.live).toStrictEqual({
      transport: "websocket",
      pollingInterval: 5000,
      webSocketUrl: "ws://localhost:3999/extended/v1/ws",
    });
  });
});
