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

  const blockRow = (height: number) => ({
    canonical: true,
    height,
    hash: `0xhash${height}`,
    block_time: 1_700_000_000,
    tenure_height: 200,
    index_block_hash: `0xindex${height}`,
    parent_block_hash: "0xparent",
    burn_block_time: 1_700_000_100,
    burn_block_height: 900,
    tx_count: 4,
  });

  const storedBlock = (height: number) => ({
    height,
    hash: `0xhash${height}`,
    index_block_hash: `0xindex${height}`,
    burn_block_time: 1_700_000_100,
    burn_block_height: 900,
  });

  test("sanitizes a single block to the fields stored for it", () => {
    expect(
      sanitizePayload("https://api.hiro.so/extended/v2/blocks/42", blockRow(42)),
    ).toStrictEqual(storedBlock(42));
  });

  test("sanitizes every row of a blocks page and keeps its paging fields", () => {
    const body = {
      limit: 30,
      offset: 120,
      total: 1000,
      next_cursor: "0xnext",
      results: [blockRow(43), blockRow(42)],
    };

    expect(
      sanitizePayload("https://api.hiro.so/extended/v2/blocks?limit=30&offset=120", body),
    ).toStrictEqual({
      limit: 30,
      offset: 120,
      total: 1000,
      results: [storedBlock(43), storedBlock(42)],
    });
  });

  test("sanitizes v3 blocks and bitcoin-blocks pages to the fields block sources read", () => {
    const cursor = { next: "41", previous: "45", current: "43" };

    const blocks = {
      total: 1000,
      limit: 2,
      cursor,
      results: [
        {
          height: 43,
          hash: "0xhash43",
          index_hash: "0xindex43",
          time: 1_700_000_000,
          time_iso: "2023-11-14T22:13:20.000Z",
          tenure_height: 40,
          tx_count: 2,
          bitcoin_block: { height: 900, hash: "0xbtc900" },
        },
      ],
    };

    expect(
      sanitizePayload("https://api.hiro.so/extended/v3/blocks?cursor=43&limit=2", blocks),
    ).toStrictEqual({
      total: 1000,
      limit: 2,
      cursor,
      results: [
        {
          height: 43,
          hash: "0xhash43",
          index_hash: "0xindex43",
          tenure_height: 40,
          bitcoin_block: { height: 900 },
        },
      ],
    });

    const bitcoinBlocks = {
      total: 500,
      limit: 2,
      cursor,
      results: [
        {
          height: 900,
          hash: "0xbtc900",
          time: 1_700_000_100,
          time_iso: "2023-11-14T22:15:00.000Z",
          projected_time: null,
          stacks_block_count: 3,
        },
      ],
    };

    expect(
      sanitizePayload(
        "https://api.hiro.so/extended/v3/bitcoin-blocks?cursor=900&limit=2",
        bitcoinBlocks,
      ),
    ).toStrictEqual({
      total: 500,
      limit: 2,
      cursor,
      results: [{ height: 900, time: 1_700_000_100 }],
    });
  });

  test("falls through to live fetch when a request is missing from fixtures", async () => {
    const fixturePath = createFixturePath();
    fs.writeFileSync(fixturePath, JSON.stringify({}));
    process.env.RECORD = "false";
    const liveBody = { results: [] };

    const fetchMock = vi
      .fn()
      .mockResolvedValue(new globalThis.Response(JSON.stringify(liveBody), { status: 200 }));

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
