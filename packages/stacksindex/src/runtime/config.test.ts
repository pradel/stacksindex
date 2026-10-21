import { Effect, Exit } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { ConfigurationError } from "../lib/errors.ts";
import { resolveIndexerConfig } from "./config.ts";

describe("indexer config", () => {
  test("polling does not need a websocket URL from a malformed api.url", async () => {
    const config = await Effect.runPromise(resolveIndexerConfig({ api: { url: "not a url" } }));

    expect(config.live).toStrictEqual({ transport: "polling", pollingInterval: 5000 });
  });

  test("websocket fails with ConfigurationError when its URL cannot be derived", async () => {
    const exit = await Effect.runPromiseExit(
      resolveIndexerConfig({ api: { url: "not a url" }, live: { transport: "websocket" } }),
    );

    expect(exit).toStrictEqual(
      Exit.fail(
        new ConfigurationError({
          message:
            'Cannot derive a websocket URL from the API URL "not a url"; set live.webSocketUrl.',
        }),
      ),
    );
  });

  test("websocket derives its URL from api.url", async () => {
    const config = await Effect.runPromise(
      resolveIndexerConfig({
        api: { url: "http://localhost:3999/" },
        live: { transport: "websocket" },
      }),
    );

    expect(config.live).toStrictEqual({
      transport: "websocket",
      pollingInterval: 5000,
      webSocketUrl: "ws://localhost:3999/extended/v1/ws",
    });
  });

  test("a custom chain uses its API URL unless api.url overrides it", async () => {
    const chain = { id: 1234, apiUrl: "http://devnet:3999" };

    await expect(Effect.runPromise(resolveIndexerConfig({ chain }))).resolves.toMatchObject({
      chainId: 1234,
      api: { baseUrl: "http://devnet:3999" },
    });
    await expect(
      Effect.runPromise(resolveIndexerConfig({ chain, api: { url: "http://node:3999" } })),
    ).resolves.toMatchObject({ chainId: 1234, api: { baseUrl: "http://node:3999" } });
  });
});
