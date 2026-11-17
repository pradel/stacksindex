import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createScenarioRecorder, sanitizePayload } from "./recorder.ts";

const originalRecord = process.env.RECORD;

let tempDirs: string[] = [];

function createFixturePath(): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "stacksindex-recorder-"));
  tempDirs.push(tempDir);

  return path.join(tempDir, "fixtures.json");
}

function toRequestError(caught: Error): Error {
  return new Error(String(caught));
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

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new globalThis.Response("rate limited", { status: 429 }));

    vi.stubGlobal("fetch", fetchMock);
    vi.useFakeTimers();
    const recorder = createScenarioRecorder(fixturePath);

    const request = recorder
      .handleRequest("https://api.example.com/rate-limited")
      .then(() => new Error("Expected rate limit request to fail"), toRequestError);

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
      new globalThis.Response("rate limited", { status: 429 }),
      new globalThis.Response(JSON.stringify({ recorded: true }), { status: 200 }),
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
          block: { hash: "0xblock", index_hash: "0xidx", height: 10, tx_index: 2 },
        },
      ],
    });
  });

  test("sanitizes v1 transaction payloads to minimal cursor fields", () => {
    const body = {
      tx_id: "0xaaa",
      nonce: 10,
      fee_rate: "100",
      sender_address: "SP123",
      block_height: 100,
      tx_index: 5,
      microblock_sequence: 2147483647,
      canonical: true,
      events: [{ event_index: 0 }],
      post_conditions: [],
    };

    expect(sanitizePayload("https://api.hiro.so/extended/v1/tx/0xaaa", body)).toStrictEqual({
      tx_id: "0xaaa",
      block_height: 100,
      tx_index: 5,
      microblock_sequence: 2147483647,
    });
  });

  test("rejects a request missing from the fixture without calling the live API", async () => {
    const fixturePath = createFixturePath();
    fs.writeFileSync(fixturePath, JSON.stringify({}));
    delete process.env.RECORD;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const recorder = createScenarioRecorder(fixturePath);

    await expect(
      recorder.handleRequest("https://api.hiro.so/extended/v3/transactions/batch?tx_id=0xunknown"),
    ).rejects.toThrow(/Missing fixture/u);
    expect(fetchMock).not.toHaveBeenCalled();

    await recorder.save();
    expect(JSON.parse(fs.readFileSync(fixturePath, "utf8"))).toStrictEqual({});
  });

  test("replays nothing from a missing fixture file unless recording", async () => {
    const fixturePath = createFixturePath();
    delete process.env.RECORD;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const recorder = createScenarioRecorder(fixturePath);

    expect(recorder.isRecording).toBe(false);
    await expect(recorder.handleRequest("https://api.hiro.so/extended")).rejects.toThrow(
      /Missing fixture/u,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    await recorder.save();
    expect(fs.existsSync(fixturePath)).toBe(false);
  });

  test("fails on a fixture file that is not valid JSON", () => {
    const fixturePath = createFixturePath();
    fs.writeFileSync(fixturePath, "{ not json");
    delete process.env.RECORD;

    expect(() => createScenarioRecorder(fixturePath)).toThrow(/fixture/u);
  });

  test("tracks calls in benchmark summary", async () => {
    const fixturePath = createFixturePath();
    const url = "https://api.hiro.so/extended/v3/smart-contracts/SP6P4.satoshibles";
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
        "GET /extended/v3/smart-contracts/:contract_id": 1,
      },
    });
  });
});
