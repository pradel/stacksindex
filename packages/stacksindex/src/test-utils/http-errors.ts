import { Exit, Option, Predicate } from "effect";
import { HttpClientError, type HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";

/**
 * Asserts that an exit failed with an `HttpClientError` and returns it.
 */
export function expectHttpClientError(
  exit: Exit.Exit<unknown, unknown>,
): HttpClientError.HttpClientError {
  const error = Exit.findErrorOption(exit);

  if (Option.isNone(error) || !HttpClientError.isHttpClientError(error.value)) {
    throw new Error("Expected an HttpClientError failure");
  }

  return error.value;
}

/**
 * Asserts a status code failure and returns the failing response for body assertions.
 */
export function expectStatusError(
  exit: Exit.Exit<unknown, unknown>,
  status: number,
): HttpClientResponse.HttpClientResponse {
  const error = expectHttpClientError(exit);

  if (!Predicate.isTagged(error.reason, "StatusCodeError")) {
    throw new Error(`Expected a StatusCodeError, got ${error.reason._tag}`);
  }

  expect(error.reason.response.status).toBe(status);

  return error.reason.response;
}

/**
 * Asserts a transport failure.
 */
export function expectTransportError(exit: Exit.Exit<unknown, unknown>): void {
  const error = expectHttpClientError(exit);

  expect(Predicate.isTagged(error.reason, "TransportError")).toBe(true);
}

/**
 * Asserts a response decoding failure.
 */
export function expectDecodeError(exit: Exit.Exit<unknown, unknown>): void {
  const error = expectHttpClientError(exit);

  expect(Predicate.isTagged(error.reason, "DecodeError")).toBe(true);
}

/**
 * Asserts that the exit failed with a defect.
 */
export function expectDie(exit: Exit.Exit<unknown, unknown>): void {
  expect(Exit.hasDies(exit)).toBe(true);
}
