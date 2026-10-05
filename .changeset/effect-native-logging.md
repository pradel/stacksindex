---
"stacksindex": minor
---

Use Effect's native logging and make the indexer database a first-class service:

- `createLogger` and the `Logger` type are removed. Provide `loggerLayer({ level })` at the composition root and log with `Effect.logInfo`, `Effect.logDebug`, and `Effect.logError`, using `Effect.annotateLogs` for structured fields and `Effect.withLogSpan` for durations.
- The `logger` option is removed from the historical runtime context.
- The sync store and `migrate` now read the database from the `IndexerDatabase` service instead of receiving a `db` argument. `migrate(options?)` replaces `migrate(db, options?)`, and `IndexerDatabase.transaction(f)` runs effects against a transaction handle that is re-provided as the service.
