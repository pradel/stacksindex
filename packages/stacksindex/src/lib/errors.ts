import { Schema } from "effect";

/** Raised when a contract's handler fails or throws; `cause` is what it failed with. */
export class HandlerExecutionError extends Schema.TaggedError<HandlerExecutionError>()(
  "HandlerExecutionError",
  {
    /** Definition name of the contract. */
    contract: Schema.String,
    contractId: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/** Raised when a block source's handler fails or throws; `cause` is what it failed with. */
export class BlockHandlerExecutionError extends Schema.TaggedError<BlockHandlerExecutionError>()(
  "BlockHandlerExecutionError",
  {
    /** Definition name of the block source (the key in `blocks`). */
    name: Schema.String,
    /** Height of the block the handler ran at. */
    blockHeight: Schema.Number,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * Raised when a print event does not match its contract's `print` schema and
 * the contract's `onInvalid` is `"fail"`.
 */
export class EventDecodeError extends Schema.TaggedError<EventDecodeError>()("EventDecodeError", {
  /** Definition name of the contract. */
  contract: Schema.String,
  contractId: Schema.String,
  txId: Schema.String,
  eventIndex: Schema.Number,
  message: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

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

/**
 * Raised when a chain reorganization replaced a block at or below the
 * finalized height, so already finalized indexed data may be wrong.
 */
export class ReorgError extends Schema.TaggedError<ReorgError>()("ReorgError", {
  finalizedBlockHeight: Schema.Number,
  blockHeight: Schema.Number,
  message: Schema.String,
}) {}
