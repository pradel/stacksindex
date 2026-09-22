// oxlint-disable vitest/max-expects
import { describe, expect, test } from "vite-plus/test";

import { createProgressTracker } from "./progress.ts";

describe("progress tracker", () => {
  test("computes percentage, block progress, and prefix across range", () => {
    const tracker = createProgressTracker({
      startBlock: 100,
      targetBlock: 200,
    });

    const atStart = tracker.getProgress(100);
    expect(atStart.percentage).toBe("0.0%");
    expect(atStart.prefix).toBe("[0.0%]");
    expect(atStart.block).toBe("100/200");
    expect(atStart.totalEvents).toBe(0);

    const atHalf = tracker.getProgress(150);
    expect(atHalf.percentage).toBe("50.0%");
    expect(atHalf.prefix).toBe("[50.0%]");
    expect(atHalf.block).toBe("150/200");

    const atEnd = tracker.getProgress(200);
    expect(atEnd.percentage).toBe("100.0%");
    expect(atEnd.prefix).toBe("[100.0%]");
    expect(atEnd.block).toBe("200/200");
    expect(atEnd.eta).toBe("0s");
  });

  test("handles startBlock equals targetBlock", () => {
    const tracker = createProgressTracker({
      startBlock: 500,
      targetBlock: 500,
    });

    const progress = tracker.getProgress(500);
    expect(progress.percentage).toBe("100.0%");
    expect(progress.block).toBe("500/500");
    expect(progress.eta).toBe("0s");
  });

  test("clamps percentage within [0%, 100%]", () => {
    const tracker = createProgressTracker({
      startBlock: 100,
      targetBlock: 200,
    });

    const beforeStart = tracker.getProgress(50);
    expect(beforeStart.percentage).toBe("0.0%");

    const afterEnd = tracker.getProgress(250);
    expect(afterEnd.percentage).toBe("100.0%");
  });

  test("tracks cumulative events indexed across batches", () => {
    const tracker = createProgressTracker({
      startBlock: 0,
      targetBlock: 100,
    });

    expect(tracker.getTotalEvents()).toBe(0);

    tracker.recordEventsIndexed(15);
    tracker.recordEventsIndexed(25);
    // Negative numbers ignored
    tracker.recordEventsIndexed(-5);

    expect(tracker.getTotalEvents()).toBe(40);
    expect(tracker.getProgress(50).totalEvents).toBe(40);
  });

  test("calculates ETA based on session progress and clock", () => {
    let elapsedMs = 0;
    const tracker = createProgressTracker({
      startBlock: 100,
      targetBlock: 200,
      sessionStartBlock: 100,
      clock: () => elapsedMs,
    });

    // Before any blocks advance in session: no ETA
    expect(tracker.getProgress(100).eta).toBeUndefined();

    // 10 blocks processed in 1,000ms (100ms per block).
    // Remaining blocks = 90.
    // Estimated remaining time = 90 * 100ms = 9,000ms (9s).
    elapsedMs = 1000;
    const progress = tracker.getProgress(110);
    expect(progress.eta).toBe("9s");
  });

  test("calculates resumed progress with overall range % and session-only ETA", () => {
    let elapsedMs = 0;
    // Resumed from block 800
    const tracker = createProgressTracker({
      startBlock: 0,
      targetBlock: 1000,
      sessionStartBlock: 800,
      clock: () => elapsedMs,
    });

    // At resume block: overall progress is 80%
    const atResume = tracker.getProgress(800);
    expect(atResume.percentage).toBe("80.0%");
    expect(atResume.prefix).toBe("[80.0%]");
    expect(atResume.block).toBe("800/1,000");
    expect(atResume.eta).toBeUndefined();

    // 50 blocks processed in session (800 -> 850) in 5,000ms (100ms per block).
    // Remaining blocks = 150.
    // Remaining time = 150 * 100ms = 15,000ms (15s).
    elapsedMs = 5000;
    const afterSessionBatch = tracker.getProgress(850);
    expect(afterSessionBatch.percentage).toBe("85.0%");
    expect(afterSessionBatch.prefix).toBe("[85.0%]");
    expect(afterSessionBatch.block).toBe("850/1,000");
    expect(afterSessionBatch.eta).toBe("15s");
  });

  test("calculates processing rate and average rate", () => {
    let elapsedMs = 0;
    const tracker = createProgressTracker({
      startBlock: 0,
      targetBlock: 1000,
      clock: () => elapsedMs,
    });

    // No events yet or < 500ms
    expect(tracker.getProgress(100).rate).toBeUndefined();
    expect(tracker.getAverageRate()).toBeUndefined();

    // 250 events in 500ms -> 500 ev/s
    tracker.recordEventsIndexed(250);
    elapsedMs = 500;
    expect(tracker.getProgress(200).rate).toBe("500 ev/s");
    expect(tracker.getAverageRate()).toBe("500 ev/s");

    // 1000 events in 2000ms -> 500 ev/s
    tracker.recordEventsIndexed(750);
    elapsedMs = 2000;
    expect(tracker.getProgress(500).rate).toBe("500 ev/s");
    expect(tracker.getAverageRate()).toBe("500 ev/s");
  });

  test("throttles logs based on interval and channels", () => {
    let elapsedMs = 0;
    const tracker = createProgressTracker({
      startBlock: 0,
      targetBlock: 1000,
      throttleIntervalMs: 1000,
      clock: () => elapsedMs,
    });

    // First call on "sync" logs
    expect(tracker.shouldLog("sync", 100)).toBe(true);

    // Call 200ms later on "sync" is throttled
    elapsedMs = 200;
    expect(tracker.shouldLog("sync", 200)).toBe(false);

    // First call on independent "index" channel logs
    expect(tracker.shouldLog("index", 200)).toBe(true);

    // Call 100ms later on "index" is throttled
    elapsedMs = 300;
    expect(tracker.shouldLog("index", 250)).toBe(false);

    // After 1000ms interval on "sync", logs again
    elapsedMs = 1100;
    expect(tracker.shouldLog("sync", 500)).toBe(true);

    // Force bypasses throttle
    elapsedMs = 1200;
    expect(tracker.shouldLog("sync", 550, true)).toBe(true);

    // Reaching targetBlock bypasses throttle
    elapsedMs = 1300;
    expect(tracker.shouldLog("sync", 1000)).toBe(true);
  });

  test("records and summarizes handler execution performance", () => {
    const tracker = createProgressTracker({
      startBlock: 0,
      targetBlock: 100,
    });

    tracker.recordHandlerExecution("SP123.contract-a", 10, "swap");
    tracker.recordHandlerExecution("SP123.contract-a", 20, "swap");
    tracker.recordHandlerExecution("SP123.contract-b", 50);

    const summaries = tracker.getHandlerSummaries();
    expect(summaries).toHaveLength(2);

    // Sorted by count descending
    expect(summaries[0]).toStrictEqual({
      contractId: "SP123.contract-a",
      topic: "swap",
      count: 2,
      totalDurationMs: 30,
      avgDurationMs: 15,
    });

    expect(summaries[1]).toStrictEqual({
      contractId: "SP123.contract-b",
      count: 1,
      totalDurationMs: 50,
      avgDurationMs: 50,
    });
  });

  test("handles undefined targetBlock gracefully", () => {
    const tracker = createProgressTracker({
      startBlock: 100,
    });

    const progress = tracker.getProgress(150);
    expect(progress.percentage).toBeUndefined();
    expect(progress.prefix).toBe("");
    expect(progress.block).toBe("150");
    expect(progress.eta).toBeUndefined();
    expect(progress.totalEvents).toBe(0);
  });
});
