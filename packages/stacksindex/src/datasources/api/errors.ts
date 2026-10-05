import { Schema } from "effect";
import type { HttpClientError } from "effect/http";
import type { RateLimiter } from "effect/persistence";

/**
 * Domain failure raised when a read-only contract call returns a Clarity
 * error response or its result cannot be decoded.
 */
export class ReadOnlyCallError extends Schema.TaggedError<ReadOnlyCallError>()(
  "ReadOnlyCallError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type StacksApiError =
  | HttpClientError.HttpClientError
  | RateLimiter.RateLimiterError
  | ReadOnlyCallError;
