import { TaggedError } from "better-result";
import type { MatcherResult, MatcherState } from "vitest";

interface ResultLike {
  isErr: () => boolean;
  isOk: () => boolean;
  error?: unknown;
}

function isResultLike(value: unknown): value is ResultLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "isErr" in value &&
    "isOk" in value &&
    typeof value.isErr === "function" &&
    typeof value.isOk === "function"
  );
}

function stripStack(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripStack(item));
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value)) {
      if (key !== "stack") {
        result[key] = stripStack(entryValue);
      }
    }
    return result;
  }
  return value;
}

function toComparable(error: unknown): unknown {
  if (TaggedError.is(error)) {
    return stripStack(error.toJSON());
  }
  if (error instanceof Error) {
    return stripStack({
      name: error.name,
      message: error.message,
      cause: error.cause,
    });
  }
  return stripStack(error);
}

export function toBeBetterErr(
  this: MatcherState,
  received: unknown,
  expected: unknown,
): MatcherResult {
  const { matcherHint, printExpected, printReceived, diff } = this.utils;

  const hint = (expectedLabel: string, receivedLabel: string): string =>
    matcherHint("toBeBetterErr", receivedLabel, expectedLabel, {
      isNot: this.isNot,
    });

  if (!TaggedError.is(expected)) {
    return {
      pass: false,
      message: (): string =>
        `${hint("expectedError", "received")}\n\nExpected matcher argument to be a better-result TaggedError.\n${printReceived(expected)}`,
    };
  }

  if (!isResultLike(received)) {
    return {
      pass: false,
      message: (): string =>
        `${hint("expectedError", "received")}\n\nExpected received value to be a better-result Result.\n${printReceived(received)}`,
    };
  }

  if (!received.isErr()) {
    return {
      pass: false,
      message: (): string =>
        `${hint("expectedError", "received")}\n\nExpected Result to be Err, but it was Ok.\n${printReceived(received)}`,
    };
  }

  const actual = received.error;

  if (!TaggedError.is(actual)) {
    return {
      pass: false,
      message: (): string =>
        `${hint("expectedError", "received")}\n\nExpected Result error to be a better-result TaggedError.\n${printReceived(actual)}`,
    };
  }

  if (actual._tag !== expected._tag) {
    const tagDiff = diff(expected._tag, actual._tag) ?? "";
    return {
      pass: false,
      message: (): string =>
        `${hint("expectedError", "received")}\n\nExpected error _tag to match.\n\nExpected _tag: ${printExpected(expected._tag)}\nReceived _tag: ${printReceived(actual._tag)}${tagDiff === "" ? "" : `\n\n${tagDiff}`}`,
    };
  }

  const actualComparable = toComparable(actual);
  const expectedComparable = toComparable(expected);
  const pass = this.equals(actualComparable, expectedComparable);
  const errorDiff = diff(expectedComparable, actualComparable) ?? "";

  return {
    pass,
    message: (): string =>
      pass
        ? `${hint("expectedError", "received")}\n\nExpected Result error not to match.\n\nExpected: ${printExpected(expectedComparable)}\nReceived: ${printReceived(actualComparable)}`
        : `${hint("expectedError", "received")}\n\nExpected Result error to match.${errorDiff === "" ? `\n\nExpected: ${printExpected(expectedComparable)}\nReceived: ${printReceived(actualComparable)}` : `\n\n${errorDiff}`}`,
  };
}

declare module "vitest" {
  // oxlint-disable-next-line id-length, typescript/no-explicit-any
  interface Assertion<T = any> {
    toBeBetterErr: (expected: unknown) => void;
  }
  interface AsymmetricMatchersContaining {
    toBeBetterErr: (expected: unknown) => void;
  }
}
