import { Exit, Option } from "effect";
import type { MatcherResult, MatcherState } from "vite-plus/test";

type ComparableValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | ComparableValue[]
  | ComparableObject;

interface ComparableObject {
  [key: string]: ComparableValue;
}

type ComparableInput = Error | ComparableValue;

function isComparableInput(value: unknown): value is ComparableInput {
  if (value === null || value === undefined) {
    return true;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return true;
  }

  if (value instanceof Error) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isComparableInput(item));
  }

  if (typeof value === "object") {
    return Object.values(value).every((entry) => isComparableInput(entry));
  }

  return false;
}

function isComparableRecord(value: ComparableInput): value is ComparableObject {
  return typeof value === "object" && value !== null;
}

function isTagged(value: ComparableInput): value is { readonly _tag: string } {
  return (
    typeof value === "object" && value !== null && "_tag" in value && typeof value._tag === "string"
  );
}

function stripCause(cause: unknown): ComparableValue {
  return isComparableInput(cause) ? stripStack(cause) : "unrepresentable cause";
}

function stripStack(value: ComparableInput): ComparableValue {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      cause: stripCause(value.cause),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => stripStack(item));
  }

  if (isComparableRecord(value)) {
    const result: ComparableObject = {};

    for (const [key, entryValue] of Object.entries(value)) {
      if (key !== "stack") {
        result[key] = stripStack(entryValue);
      }
    }

    return result;
  }

  return value;
}

function toComparable(value: ComparableInput): ComparableObject {
  if (!isComparableRecord(value)) {
    return { value: stripStack(value) };
  }

  const result: ComparableObject = {};

  for (const key of Object.getOwnPropertyNames(value)) {
    if (key !== "stack") {
      result[key] = stripStack(value[key]);
    }
  }

  for (const [key, entryValue] of Object.entries(value)) {
    if (key !== "stack") {
      result[key] = stripStack(entryValue);
    }
  }

  return result;
}

export function toBeTaggedError(
  this: MatcherState,
  received: Exit.Exit<unknown, unknown> | ComparableInput,
  expected: ComparableInput,
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

  let actual: ComparableInput;

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
      if (!isComparableInput(opt.value)) {
        return {
          pass: false,
          message: (): string =>
            `${hint("expectedError", "received")}\n\nExpected error to have a _tag property.\n${printReceived(opt.value)}`,
        };
      }

      actual = opt.value;
    } else {
      return {
        pass: false,
        message: (): string =>
          `${hint("expectedError", "received")}\n\nExpected Exit to contain an error, but it did not.\n${printReceived(received.cause)}`,
      };
    }
  } else {
    actual = received;
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

  for (const key of Object.keys(expectedComparable)) {
    if (!this.equals(actualComparable[key], expectedComparable[key])) {
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
  // oxlint-disable-next-line id-length
  interface Assertion<R extends void | Promise<void> = void, T = unknown> {
    toBeTaggedError: (expected: ComparableInput) => void;
    toBeBetterErr: (expected: ComparableInput) => R;
  }

  interface AsymmetricMatchersContaining {
    toBeTaggedError: (expected: ComparableInput) => void;
    toBeBetterErr: (expected: ComparableInput) => void;
  }
}
