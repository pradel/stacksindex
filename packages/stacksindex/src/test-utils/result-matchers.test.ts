import { Exit, Schema } from "effect";
import { describe, expect, test } from "vite-plus/test";

import { StacksApiResponseError } from "../datasources/api/errors.ts";

class TestErrorA extends Schema.TaggedError<TestErrorA>()("TestErrorA", {
  message: Schema.String,
  code: Schema.Number,
}) {}

class TestErrorB extends Schema.TaggedError<TestErrorB>()("TestErrorB", {
  message: Schema.String,
}) {}

class TestCauseError extends Schema.TaggedError<TestCauseError>()("TestCauseError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

describe("toBeTaggedError", () => {
  test("passes when Exit error deep-equals the expected error", () => {
    const result = Exit.fail(new TestErrorA({ message: "boom", code: 42 }));
    expect(result).toBeTaggedError(new TestErrorA({ message: "boom", code: 42 }));
  });

  test("passes when received is the error directly", () => {
    const err = new TestErrorA({ message: "boom", code: 42 });
    expect(err).toBeTaggedError(new TestErrorA({ message: "boom", code: 42 }));
  });

  test("passes for real domain errors with identical props", () => {
    const result = Exit.fail(
      new StacksApiResponseError({
        status: 404,
        statusText: "Not Found",
        path: "/extended/v3/transactions/404",
        errorData: { error: "Not found" },
      }),
    );
    expect(result).toBeTaggedError(
      new StacksApiResponseError({
        status: 404,
        statusText: "Not Found",
        path: "/extended/v3/transactions/404",
        errorData: { error: "Not found" },
      }),
    );
  });

  test("ignores stack traces and compares cause by value", () => {
    const result = Exit.fail(new TestCauseError({ message: "wrapped", cause: new Error("root") }));
    expect(result).toBeTaggedError(
      new TestCauseError({ message: "wrapped", cause: new Error("root") }),
    );
  });

  test("supports .not when errors differ", () => {
    const result = Exit.fail(new TestErrorA({ message: "boom", code: 42 }));
    expect(result).not.toBeTaggedError(new TestErrorA({ message: "boom", code: 7 }));
  });

  test("fails when Exit is Success", () => {
    const result = Exit.succeed(42);
    expect(() => {
      expect(result).toBeTaggedError(new TestErrorA({ message: "boom", code: 42 }));
    }).toThrow(/Expected Exit to be Failure/u);
  });

  test("fails when received has no _tag", () => {
    expect(() => {
      expect("plain string").toBeTaggedError(new TestErrorA({ message: "boom", code: 42 }));
    }).toThrow(/Expected error to have a _tag property/u);
  });

  test("fails when expected argument has no _tag", () => {
    const result = Exit.fail(new TestErrorA({ message: "boom", code: 42 }));
    expect(() => {
      expect(result).toBeTaggedError({ message: "boom" });
    }).toThrow(/Expected matcher argument to have a _tag property/u);
  });

  test("fails on _tag mismatch", () => {
    const result = Exit.fail(new TestErrorA({ message: "boom", code: 42 }));
    expect(() => {
      expect(result).toBeTaggedError(new TestErrorB({ message: "boom" }));
    }).toThrow(/Expected error _tag to match/u);
  });

  test("fails on prop mismatch", () => {
    const result = Exit.fail(new TestErrorA({ message: "boom", code: 42 }));
    expect(() => {
      expect(result).toBeTaggedError(new TestErrorA({ message: "boom", code: 7 }));
    }).toThrow(/Expected error to match/u);
  });

  test("fails on cause mismatch", () => {
    const result = Exit.fail(new TestCauseError({ message: "wrapped", cause: new Error("root") }));
    expect(() => {
      expect(result).toBeTaggedError(
        new TestCauseError({ message: "wrapped", cause: new Error("different") }),
      );
    }).toThrow(/Expected error to match/u);
  });
});
