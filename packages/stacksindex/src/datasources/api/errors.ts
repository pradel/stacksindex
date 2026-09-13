import { Schema } from "effect";

export class StacksApiUnexpectedError extends Schema.TaggedError<StacksApiUnexpectedError>()(
  "StacksApiUnexpectedError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
    path: Schema.String,
  },
) {}

export class StacksApiResponseError extends Schema.TaggedError<StacksApiResponseError>()(
  "StacksApiResponseError",
  {
    status: Schema.Number,
    path: Schema.String,
    statusText: Schema.String,
    errorData: Schema.optional(Schema.Unknown),
  },
) {}

export class StacksApiRateLimitError extends Schema.TaggedError<StacksApiRateLimitError>()(
  "StacksApiRateLimitError",
  {
    path: Schema.String,
    retryAfter: Schema.Number,
  },
) {}

export class StacksApiParseError extends Schema.TaggedError<StacksApiParseError>()(
  "StacksApiParseError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type StacksApiError =
  | StacksApiUnexpectedError
  | StacksApiResponseError
  | StacksApiRateLimitError
  | StacksApiParseError;
