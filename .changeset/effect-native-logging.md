---
"stacksindex": minor
---

Use Effect's native logging and make the indexer capabilities first-class services:

- `createLogger` and the `Logger` type are removed. Provide `loggerLayer({ level })` at the composition root and log with `Effect.logInfo`, `Effect.logDebug`, and `Effect.logError`, using `Effect.annotateLogs` for structured fields and `Effect.withLogSpan` for durations.
- The sync store and `migrate` now read the database from the `IndexerDatabase` service instead of receiving a `db` argument. `migrate(options?)` replaces `migrate(db, options?)`, and `IndexerDatabase.transaction(f)` runs effects against a transaction handle that is re-provided as the service.
- `createHistoricalRuntime(context)` is replaced by the `HistoricalRuntime` service. `HistoricalRuntime.layer({ network, api })` provides the configured runtime, and `run(filters)` requires the `IndexerDatabase` service. The promise-based `createHistoricalRuntimePromise({ db, network, api })` wrapper remains.
- Handler execution is exposed through the `Indexing` service (`Indexing.layer({ handlers })`).
