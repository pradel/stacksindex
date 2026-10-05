import { Schema } from "effect";

export class HandlerExecutionError extends Schema.TaggedError<HandlerExecutionError>()(
  "HandlerExecutionError",
  {
    contractId: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class FilterValidationError extends Schema.TaggedError<FilterValidationError>()(
  "FilterValidationError",
  {
    message: Schema.String,
  },
) {}

export class SyncStoreError extends Schema.TaggedError<SyncStoreError>()("SyncStoreError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Raised when the transactions batch endpoint omits requested transaction ids.
 */
export class TransactionBatchError extends Schema.TaggedError<TransactionBatchError>()(
  "TransactionBatchError",
  {
    missingIds: Schema.Array(Schema.String),
  },
) {}
