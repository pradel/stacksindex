import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Response } from "undici";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createScenarioRecorder, parseBatchTxIds, sanitizePayload } from "./recorder.ts";

const originalRecord = process.env.RECORD;
let tempDirs: string[] = [];

function createFixturePath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stacksindex-recorder-"));
  tempDirs.push(tempDir);
  return path.join(tempDir, "fixtures.json");
}

describe("scenario recorder", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    if (originalRecord === undefined) {
      delete process.env.RECORD;
    } else {
      process.env.RECORD = originalRecord;
    }
    for (const tempDir of tempDirs) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs = [];
  });

  test.each(["false", "0"])("replays fixtures when RECORD=%s", async (recordValue) => {
    const fixturePath = createFixturePath();
    const url = "https://api.example.com/fixture";
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({ [`GET ${url}`]: { statusCode: 200, body: { replayed: true } } }),
    );
    process.env.RECORD = recordValue;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const recorder = createScenarioRecorder(fixturePath);
    const response = await recorder.handleRequest(url);

    expect(response.statusCode).toBe(200);
    await expect(response.body.json()).resolves.toStrictEqual({ replayed: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects after the final rate-limited response without archiving it", async () => {
    const fixturePath = createFixturePath();
    process.env.RECORD = "true";
    const fetchMock = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const recorder = createScenarioRecorder(fixturePath);
    const request = recorder.handleRequest("https://api.example.com/rate-limited").then(
      () => new Error("Expected rate limit request to fail"),
      (caught: unknown) => new Error(String(caught)),
    );

    await vi.runAllTimersAsync();

    const error = await request;
    expect(error.message).toContain("Rate limited after 5 attempts");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(recorder.size()).toBe(0);
    await recorder.save();
    expect(JSON.parse(fs.readFileSync(fixturePath, "utf8"))).toStrictEqual({});
  });

  test("records a successful response after a rate-limited retry", async () => {
    const fixturePath = createFixturePath();
    process.env.RECORD = "true";
    const responses = [
      new Response("rate limited", { status: 429 }),
      new Response(JSON.stringify({ recorded: true }), { status: 200 }),
    ];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(responses[0])
      .mockResolvedValueOnce(responses[1]);
    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const recorder = createScenarioRecorder(fixturePath);
    const request = recorder.handleRequest("https://api.example.com/retry-success");

    await vi.runAllTimersAsync();

    const response = await request;
    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recorder.size()).toBe(1);
  });

  test("parses batch transaction ids from repeated and comma-separated params", () => {
    expect(
      parseBatchTxIds("https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xaaa&tx_id=0xbbb"),
    ).toStrictEqual(["0xaaa", "0xbbb"]);
    expect(
      parseBatchTxIds("https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xaaa,0xbbb"),
    ).toStrictEqual(["0xaaa", "0xbbb"]);
    expect(parseBatchTxIds("https://api.hiro.so/extended/v3/transactions/0xaaa")).toBeNull();
    expect(parseBatchTxIds("not a url")).toBeNull();
  });

  test("sanitizes batch transaction payloads to summary fields", () => {
    const body = {
      results: [
        {
          tx_id: "0xaaa",
          type: "contract_call",
          status: "success",
          fee_rate: "100",
          sender: { address: "SP123", nonce: 1 },
          sponsor: null,
          fee: "dropped",
          block: { hash: "0xblock", height: 10, time: 99, tx_index: 2, index_hash: "0xidx" },
          event_count: 3,
          events: [],
        },
      ],
    };
    expect(
      sanitizePayload("https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xaaa", body),
    ).toStrictEqual({
      results: [
        {
          tx_id: "0xaaa",
          type: "contract_call",
          status: "success",
          fee_rate: "100",
          sender: { address: "SP123", nonce: 1 },
          block: { hash: "0xblock", height: 10, tx_index: 2 },
        },
      ],
    });
  });

  test("synthesizes batch lookups from archived single transactions in replay mode", async () => {
    const fixturePath = createFixturePath();
    const txUrl = (id: string) => `https://api.hiro.so/extended/v3/transactions/${id}`;
    const txBody = (id: string, height: number) => ({
      tx_id: id,
      event_count: 1,
      type: "contract_call",
      status: "success",
      fee_rate: "100",
      sender: { address: "SP123", nonce: 0 },
      block: { hash: `block-${height}`, height, time: 1000, tx_index: 0 },
      canonical: true,
    });
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({
        [`GET ${txUrl("0xaaa")}`]: { statusCode: 200, body: txBody("0xaaa", 10) },
        [`GET ${txUrl("0xbbb")}`]: { statusCode: 200, body: txBody("0xbbb", 20) },
      }),
    );
    process.env.RECORD = "false";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const recorder = createScenarioRecorder(fixturePath);
    const response = await recorder.handleRequest(
      "https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xaaa&tx_id=0xbbb",
    );

    expect(response.statusCode).toBe(200);
    await expect(response.body.json()).resolves.toStrictEqual({
      results: [
        {
          tx_id: "0xaaa",
          type: "contract_call",
          status: "success",
          fee_rate: "100",
          sender: { address: "SP123", nonce: 0 },
          block: { hash: "block-10", height: 10, tx_index: 0 },
        },
        {
          tx_id: "0xbbb",
          type: "contract_call",
          status: "success",
          fee_rate: "100",
          sender: { address: "SP123", nonce: 0 },
          block: { hash: "block-20", height: 20, tx_index: 0 },
        },
      ],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("falls through to live fetch when a batch id is missing from fixtures", async () => {
    const fixturePath = createFixturePath();
    fs.writeFileSync(fixturePath, JSON.stringify({}));
    process.env.RECORD = "false";
    const liveBody = { results: [] };
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify(liveBody), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const recorder = createScenarioRecorder(fixturePath);
    const response = await recorder.handleRequest(
      "https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xunknown",
    );

    expect(response.statusCode).toBe(200);
    await expect(response.body.json()).resolves.toStrictEqual(liveBody);
    // oxlint-disable-next-line vitest/prefer-called-once
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("tracks calls in benchmark summary", async () => {
    const fixturePath = createFixturePath();
    const url = "https://api.hiro.so/extended/v1/contract/SP6P4.satoshibles";
    fs.writeFileSync(
      fixturePath,
      JSON.stringify({ [`GET ${url}`]: { statusCode: 200, body: {} } }),
    );
    process.env.RECORD = "false";
    const recorder = createScenarioRecorder(fixturePath);
    await recorder.handleRequest(url);

    expect(recorder.getBenchmarkSummary()).toStrictEqual({
      totalCalls: 1,
      endpoints: {
        "GET /extended/v1/contract/:contract_id": 1,
      },
    });
  });
});
