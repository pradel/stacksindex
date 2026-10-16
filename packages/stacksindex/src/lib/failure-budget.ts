/**
 * Consecutive failures tolerated while following the chain, after Ponder's
 * realtime error budget: retrying stops only once at least `maxFailures`
 * attempts failed in a row and those failures span at least `minSpanMillis`,
 * so neither a short burst nor a slow trickle of errors is fatal on its own.
 */
export interface FailureBudget {
  /** Records a failure at `nowMillis`; returns `true` once the budget is spent. */
  readonly recordFailure: (nowMillis: number) => boolean;
  /** Clears the streak after a success. */
  readonly reset: () => void;
  /** Failures in the current streak. */
  readonly consecutiveFailures: () => number;
}

export const DEFAULT_MAX_CONSECUTIVE_FAILURES = 10;

export const DEFAULT_MIN_FAILURE_SPAN_MILLIS = 10 * 60 * 1000;

export function createFailureBudget(options?: {
  readonly maxFailures?: number;
  readonly minSpanMillis?: number;
}): FailureBudget {
  const maxFailures = options?.maxFailures ?? DEFAULT_MAX_CONSECUTIVE_FAILURES;
  const minSpanMillis = options?.minSpanMillis ?? DEFAULT_MIN_FAILURE_SPAN_MILLIS;
  let failures = 0;
  let firstFailureAtMillis = 0;

  return {
    recordFailure: (nowMillis) => {
      if (failures === 0) {
        firstFailureAtMillis = nowMillis;
      }

      failures += 1;

      return failures >= maxFailures && nowMillis - firstFailureAtMillis >= minSpanMillis;
    },
    reset: () => {
      failures = 0;
    },
    consecutiveFailures: () => failures,
  };
}
