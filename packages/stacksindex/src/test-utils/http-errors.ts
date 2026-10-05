import { Cause, Effect, Exit, Option, Predicate } from "effect";
import { HttpClientError, type HttpClientResponse } from "effect/http";
import { expect } from "vite-plus/test";

type ExpectedBody =
  | string
  | number
  | boolean
  | null
  | undefined
  | ExpectedBody[]
  | { [key: string]: ExpectedBody };

interface ExpectedStatusError {
  readonly status: number;
  readonly path: string;
  readonly body?: ExpectedBody;
}

interface ExpectedTransportError {
  readonly path: string;
  readonly causeMessage?: string;
}

interface ExpectedDecodeError {
  readonly path: string;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function parseBody(text: string): ExpectedBody {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

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
 * Asserts a status code failure with its request path and error body.
 */
export async function expectStatusError(
  exit: Exit.Exit<unknown, unknown>,
  expected: ExpectedStatusError,
): Promise<HttpClientResponse.HttpClientResponse> {
  const error = expectHttpClientError(exit);

  if (!Predicate.isTagged(error.reason, "StatusCodeError")) {
    throw new Error(`Expected a StatusCodeError, got ${error.reason._tag}`);
  }

  expect(error.reason.response.status).toBe(expected.status);
  expect(new URL(error.reason.request.url).pathname).toBe(expected.path);

  if ("body" in expected) {
    const text = await Effect.runPromise(error.reason.response.text);

    expect(parseBody(text)).toStrictEqual(expected.body);
  }

  return error.reason.response;
}

/**
 * Asserts a transport failure with its request path and cause message.
 */
export function expectTransportError(
  exit: Exit.Exit<unknown, unknown>,
  expected: ExpectedTransportError,
): void {
  const error = expectHttpClientError(exit);

  if (!Predicate.isTagged(error.reason, "TransportError")) {
    throw new Error(`Expected a TransportError, got ${error.reason._tag}`);
  }

  expect(new URL(error.reason.request.url).pathname).toBe(expected.path);

  if (expected.causeMessage !== undefined) {
    expect(messageOf(error.reason.cause)).toBe(expected.causeMessage);
  }
}

/**
 * Asserts a response decoding failure and returns its reason for cause assertions.
 */
export function expectDecodeError(
  exit: Exit.Exit<unknown, unknown>,
  expected: ExpectedDecodeError,
): HttpClientError.DecodeError {
  const error = expectHttpClientError(exit);

  if (!Predicate.isTagged(error.reason, "DecodeError")) {
    throw new Error(`Expected a DecodeError, got ${error.reason._tag}`);
  }

  expect(new URL(error.reason.request.url).pathname).toBe(expected.path);

  return error.reason;
}

/**
 * Asserts that the exit failed with a defect carrying the given message.
 */
export function expectDie(exit: Exit.Exit<unknown, unknown>, message: string): void {
  expect(Exit.hasDies(exit)).toBe(true);

  if (!Exit.isFailure(exit)) {
    return;
  }

  expect(messageOf(Cause.squash(exit.cause))).toBe(message);
}
