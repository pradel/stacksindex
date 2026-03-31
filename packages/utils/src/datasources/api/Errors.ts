import { RequestError, ResponseError } from "@effect/platform/HttpClientError";
import type { HttpClientError } from "@effect/platform/HttpClientError";
import { Data } from "effect";
import type { ParseError } from "effect/ParseResult";

export const StacksApiErrorTypeId = Symbol.for("@stacksindex/utils/StacksApiError");
export type StacksApiErrorTypeId = typeof StacksApiErrorTypeId;

export class StacksApiRequestError extends Data.TaggedError(
  "@stacksindex/utils/StacksApiError/Request",
)<{
  readonly request: RequestError["request"];
  readonly cause: RequestError["cause"];
}> {
  override get message() {
    return `Stacks API request failed: ${String(this.cause)}`;
  }
}

export class StacksApiResponseError extends Data.TaggedError(
  "@stacksindex/utils/StacksApiError/Response",
)<{
  readonly request: ResponseError["request"];
  readonly response: ResponseError["response"];
  readonly status: number;
  readonly cause: ResponseError["cause"];
}> {
  override get message() {
    return `Stacks API response error: status ${this.status}`;
  }
}

export class StacksApiParseError extends Data.TaggedError(
  "@stacksindex/utils/StacksApiError/Parse",
)<{
  readonly cause: unknown;
}> {
  override get message() {
    return `Stacks API response parse error`;
  }
}

export type StacksApiError = StacksApiRequestError | StacksApiResponseError | StacksApiParseError;

export function fromHttpClientError(error: HttpClientError): StacksApiError {
  if (error instanceof RequestError) {
    return new StacksApiRequestError({
      request: error.request,
      cause: error.cause,
    });
  }
  if (error instanceof ResponseError) {
    return new StacksApiResponseError({
      request: error.request,
      response: error.response,
      status: error.response.status,
      cause: error.cause,
    });
  }
  return new StacksApiParseError({ cause: error });
}

export function fromParseError(error: ParseError): StacksApiParseError {
  return new StacksApiParseError({ cause: error });
}
