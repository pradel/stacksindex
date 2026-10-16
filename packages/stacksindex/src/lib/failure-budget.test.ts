import { describe, expect, test } from "vite-plus/test";

import { createFailureBudget } from "./failure-budget.ts";

const MINUTE = 60 * 1000;

describe("failure budget", () => {
  test("is spent only once both the failure count and the time span are reached", () => {
    const budget = createFailureBudget({ maxFailures: 3, minSpanMillis: 10 * MINUTE });

    expect(budget.recordFailure(0)).toBe(false);
    expect(budget.recordFailure(MINUTE)).toBe(false);
    // Third failure: count reached, span (2 min) not.
    expect(budget.recordFailure(2 * MINUTE)).toBe(false);
    // Span reached on the fourth failure.
    expect(budget.recordFailure(10 * MINUTE)).toBe(true);
  });

  test("a long span with too few failures is not spent", () => {
    const budget = createFailureBudget({ maxFailures: 3, minSpanMillis: 10 * MINUTE });

    expect(budget.recordFailure(0)).toBe(false);
    expect(budget.recordFailure(30 * MINUTE)).toBe(false);
  });

  test("a success restarts the streak and its span", () => {
    const budget = createFailureBudget({ maxFailures: 2, minSpanMillis: 10 * MINUTE });

    budget.recordFailure(0);
    budget.reset();

    expect(budget.consecutiveFailures()).toBe(0);
    // The span is measured from the first failure after the reset.
    expect(budget.recordFailure(20 * MINUTE)).toBe(false);
    expect(budget.recordFailure(25 * MINUTE)).toBe(false);
    expect(budget.recordFailure(30 * MINUTE)).toBe(true);
  });
});
