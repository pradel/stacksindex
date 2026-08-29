import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { Response } from "undici";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { createScenarioRecorder } from "./recorder.ts";

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
});
