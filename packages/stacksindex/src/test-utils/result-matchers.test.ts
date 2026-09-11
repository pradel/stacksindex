import { Result, TaggedError } from "better-result";
import { describe, expect, test } from "vite-plus/test";

import { StacksApiResponseError } from "../datasources/api/errors.ts";

class TestErrorA extends TaggedError("TestErrorA")<{
  message: string;
  code: number;
}> {}

class TestErrorB extends TaggedError("TestErrorB")<{
  message: string;
}> {}

class TestCauseError extends TaggedError("TestCauseError")<{
  message: string;
  cause: unknown;
}> {}

describe("toBeErr", () => {
  test("passes when Result error deep-equals the expected error", () => {
    const result = Result.err(new TestErrorA({ message: "boom", code: 42 }));
    expect(result).toBeErr(new TestErrorA({ message: "boom", code: 42 }));
  });

  test("passes for real domain errors with identical props", () => {
    const result = Result.err(
      new StacksApiResponseError({
        status: 404,
        statusText: "Not Found",
        path: "/extended/v3/transactions/404",
        errorData: { error: "Not found" },
      }),
    );
    expect(result).toBeErr(
      new StacksApiResponseError({
        status: 404,
        statusText: "Not Found",
        path: "/extended/v3/transactions/404",
        errorData: { error: "Not found" },
      }),
    );
  });

  test("ignores stack traces and compares cause by value", () => {
    const result = Result.err(new TestCauseError({ message: "wrapped", cause: new Error("root") }));
    expect(result).toBeErr(new TestCauseError({ message: "wrapped", cause: new Error("root") }));
  });

  test("supports .not when errors differ", () => {
    const result = Result.err(new TestErrorA({ message: "boom", code: 42 }));
    expect(result).not.toBeErr(new TestErrorA({ message: "boom", code: 7 }));
  });

  test("fails when Result is Ok", () => {
    const result = Result.ok(42);
    expect(() => {
      expect(result).toBeErr(new TestErrorA({ message: "boom", code: 42 }));
    }).toThrow(/Expected Result to be Err/u);
  });

  test("fails when received is not a Result", () => {
    expect(() => {
      expect({ error: "nope" }).toBeErr(new TestErrorA({ message: "boom", code: 42 }));
    }).toThrow(/Expected received value to be a better-result Result/u);
  });

  test("fails when Result error is not a TaggedError", () => {
    expect(() => {
      expect(Result.err("boom")).toBeErr(new TestErrorA({ message: "x", code: 1 }));
    }).toThrow(/Expected Result error to be a better-result TaggedError/u);
    expect(() => {
      expect(Result.err(new Error("plain"))).toBeErr(new TestErrorA({ message: "x", code: 1 }));
    }).toThrow(/Expected Result error to be a better-result TaggedError/u);
  });

  test("fails when expected argument is not a TaggedError", () => {
    const result = Result.err(new TestErrorA({ message: "boom", code: 42 }));
    expect(() => {
      expect(result).toBeErr({ _tag: "TestErrorA" });
    }).toThrow(/Expected matcher argument to be a better-result TaggedError/u);
  });

  test("fails on _tag mismatch", () => {
    const result = Result.err(new TestErrorA({ message: "boom", code: 42 }));
    expect(() => {
      expect(result).toBeErr(new TestErrorB({ message: "boom" }));
    }).toThrow(/Expected error _tag to match/u);
  });

  test("fails on prop mismatch", () => {
    const result = Result.err(new TestErrorA({ message: "boom", code: 42 }));
    expect(() => {
      expect(result).toBeErr(new TestErrorA({ message: "boom", code: 7 }));
    }).toThrow(/Expected Result error to match/u);
  });

  test("fails on cause mismatch", () => {
    const result = Result.err(new TestCauseError({ message: "wrapped", cause: new Error("root") }));
    expect(() => {
      expect(result).toBeErr(
        new TestCauseError({ message: "wrapped", cause: new Error("different") }),
      );
    }).toThrow(/Expected Result error to match/u);
  });
});
