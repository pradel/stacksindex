import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { ConfigurationError } from "../lib/errors.ts";
import { createIndexer } from "../promise/index.ts";

interface ExportRequest {
  readonly url: string;
  readonly method: string | undefined;
}

describe("telemetry", () => {
  const requests: ExportRequest[] = [];

  beforeAll(() => {
    // The HTTP client keeps the first `fetch` it sees, so stub it once for the file.
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      requests.push({ url: String(input), method: init?.method });

      return Promise.resolve(new Response(null, { status: 200 }));
    });
  });

  beforeEach(() => {
    requests.length = 0;
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  test("close() pushes the metrics to /v1/metrics on the OTLP base URL", async () => {
    const indexer = await createIndexer({
      database: { kind: "pglite" },
      logLevel: "None",
      telemetry: { otlp: { baseUrl: "http://collector.test/" } },
    });

    await indexer.close();

    expect(requests).toStrictEqual([{ url: "http://collector.test/v1/metrics", method: "POST" }]);
  });

  test("keeps the base URL's query parameters after the /v1/metrics path", async () => {
    const indexer = await createIndexer({
      database: { kind: "pglite" },
      logLevel: "None",
      telemetry: { otlp: { baseUrl: "http://collector.test/otlp/?tenant=a" } },
    });

    await indexer.close();

    expect(requests).toStrictEqual([
      { url: "http://collector.test/otlp/v1/metrics?tenant=a", method: "POST" },
    ]);
  });

  test("rejects an otlp option without baseUrl", async () => {
    await expect(
      createIndexer({
        database: { kind: "pglite" },
        logLevel: "None",
        // @ts-expect-error -- baseUrl is required; plain JavaScript callers can omit it.
        telemetry: { otlp: {} },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  test.each(["not a url", "collector.test:4318", "ftp://collector.test"])(
    "rejects baseUrl %j, which is not an http(s) URL",
    async (baseUrl) => {
      await expect(
        createIndexer({
          database: { kind: "pglite" },
          logLevel: "None",
          telemetry: { otlp: { baseUrl } },
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    },
  );

  test("rejects a negative exportInterval", async () => {
    await expect(
      createIndexer({
        database: { kind: "pglite" },
        logLevel: "None",
        telemetry: { otlp: { baseUrl: "http://collector.test", exportInterval: -1 } },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });
});
