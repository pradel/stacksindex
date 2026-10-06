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
 * Raised when connecting to or running a transaction against the indexer
 * database fails.
 */
export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  operation: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Raised when applying pending migrations to the indexer database fails.
 */
export class MigrationError extends Schema.TaggedError<MigrationError>()("MigrationError", {
  cause: Schema.optional(Schema.Unknown),
}) {}

/**
 * Raised when runtime options cannot be decoded from their supplied values.
 */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  {
    message: Schema.String,
  },
) {}

/**
 * Raised when a persisted or API supplied pagination cursor cannot be decoded.
 */
export class InvalidCursorError extends Schema.TaggedError<InvalidCursorError>()(
  "InvalidCursorError",
  {
    format: Schema.Literals(["logs", "transaction"]),
    cursor: Schema.String,
    message: Schema.String,
  },
) {}

/**
 * Raised when the transactions batch endpoint omits requested transaction ids.
 */
export class TransactionBatchError extends Schema.TaggedError<TransactionBatchError>()(
  "TransactionBatchError",
  {
    missingIds: Schema.Array(Schema.String),
  },
) {}
