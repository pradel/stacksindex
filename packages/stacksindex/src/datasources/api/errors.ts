import { Schema } from "effect";

export class StacksApiResponseError extends Schema.TaggedError<StacksApiResponseError>()(
  "StacksApiResponseError",
  {
    status: Schema.Number,
    path: Schema.String,
    body: Schema.optional(Schema.Unknown),
  },
) {}

export class StacksApiTransportError extends Schema.TaggedError<StacksApiTransportError>()(
  "StacksApiTransportError",
  {
    path: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class StacksApiParseError extends Schema.TaggedError<StacksApiParseError>()(
  "StacksApiParseError",
  {
    path: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class StacksApiUnexpectedError extends Schema.TaggedError<StacksApiUnexpectedError>()(
  "StacksApiUnexpectedError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
    path: Schema.String,
  },
) {}

export type StacksApiError =
  | StacksApiResponseError
  | StacksApiTransportError
  | StacksApiParseError
  | StacksApiUnexpectedError;
