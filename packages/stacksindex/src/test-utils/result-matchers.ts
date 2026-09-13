import { Exit, Option } from "effect";
import type { MatcherResult, MatcherState } from "vitest";

function isTagged(value: unknown): value is { _tag: string } {
  return typeof value === "object" && value !== null && "_tag" in value;
}

function stripStack(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: stripStack(value.cause),
    };
  }
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
  if (typeof error === "object" && error !== null) {
    const result: Record<string, unknown> = {};
    for (const key of Object.getOwnPropertyNames(error)) {
      if (key !== "stack") {
        // oxlint-disable-next-line typescript/no-explicit-any
        result[key] = stripStack((error as any)[key]);
      }
    }
    for (const [key, val] of Object.entries(error)) {
      if (key !== "stack") {
        result[key] = stripStack(val);
      }
    }
    return result;
  }
  return stripStack(error);
}

export function toBeTaggedError(
  this: MatcherState,
  received: unknown,
  expected: unknown,
): MatcherResult {
  const { matcherHint, printExpected, printReceived, diff } = this.utils;

  const hint = (expectedLabel: string, receivedLabel: string): string =>
    matcherHint("toBeTaggedError", receivedLabel, expectedLabel, {
      isNot: this.isNot,
    });

  if (!isTagged(expected)) {
    return {
      pass: false,
      message: (): string =>
        `${hint("expectedError", "received")}\n\nExpected matcher argument to have a _tag property.\n${printReceived(expected)}`,
    };
  }

  let actual = received;
  if (Exit.isExit(received)) {
    if (Exit.isSuccess(received)) {
      return {
        pass: false,
        message: (): string =>
          `${hint("expectedError", "received")}\n\nExpected Exit to be Failure, but it was Success.\n${printReceived(received.value)}`,
      };
    }
    const opt = Exit.findErrorOption(received);
    if (Option.isSome(opt)) {
      actual = opt.value;
    } else {
      return {
        pass: false,
        message: (): string =>
          `${hint("expectedError", "received")}\n\nExpected Exit to contain an error, but it did not.\n${printReceived(received.cause)}`,
      };
    }
  }

  if (!isTagged(actual)) {
    return {
      pass: false,
      message: (): string =>
        `${hint("expectedError", "received")}\n\nExpected error to have a _tag property.\n${printReceived(actual)}`,
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
  let pass = true;
  for (const key of Object.keys(expectedComparable as object)) {
    // oxlint-disable-next-line typescript/no-explicit-any, typescript/no-unsafe-member-access
    if (!this.equals((actualComparable as any)[key], (expectedComparable as any)[key])) {
      pass = false;
      break;
    }
  }
  const errorDiff = diff(expectedComparable, actualComparable) ?? "";

  return {
    pass,
    message: (): string =>
      pass
        ? `${hint("expectedError", "received")}\n\nExpected error not to match.\n\nExpected: ${printExpected(expectedComparable)}\nReceived: ${printReceived(actualComparable)}`
        : `${hint("expectedError", "received")}\n\nExpected error to match.${errorDiff === "" ? `\n\nExpected: ${printExpected(expectedComparable)}\nReceived: ${printReceived(actualComparable)}` : `\n\n${errorDiff}`}`,
  };
}

export const toBeBetterErr = toBeTaggedError;

declare module "vitest" {
  // oxlint-disable-next-line id-length, typescript/no-explicit-any
  interface Assertion<T = any> {
    toBeTaggedError: (expected: unknown) => void;
    toBeBetterErr: (expected: unknown) => void;
  }
  interface AsymmetricMatchersContaining {
    toBeTaggedError: (expected: unknown) => void;
    toBeBetterErr: (expected: unknown) => void;
  }
}
