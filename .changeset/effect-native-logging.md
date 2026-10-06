---
"stacksindex": minor
---

Use Effect's native logging and make the indexer capabilities first-class services:

- `createLogger` and the `Logger` type are removed. Provide `loggerLayer({ level })` at the composition root and log with `Effect.logInfo`, `Effect.logDebug`, and `Effect.logError`, using `Effect.annotateLogs` for structured fields and `Effect.withLogSpan` for durations.
- The sync store and `migrate` now read the database from the `IndexerDatabase` service instead of receiving a `db` argument. `migrate(options?)` replaces `migrate(db, options?)`, and `IndexerDatabase.transaction(f)` runs effects against a transaction handle that is re-provided as the service.
- `createHistoricalRuntime(context)` is replaced by the `HistoricalRuntime` service. `HistoricalRuntime.layer({ network, api })` provides the configured runtime, and `run(filters)` requires the `IndexerDatabase` service. Handler execution is exposed through the `Indexing` service (`Indexing.layer({ handlers })`).
- The core handler contract is Effect-only: `EventHandler` returns an `Effect`, and `IndexingClient.callReadOnly` returns an `Effect`.
- The promise API is now a boundary adapter: `createHistoricalRuntimePromise({ db, network, api, level })` accepts `PromiseFilter`s, bridges promise handlers, and provides a `PromiseHandlerContext` with a thenable `client`/`db`, a `decode` returning a `Promise`, and a `logger` bound to the configured Effect logger.
- `createDatabase` and `DatabaseResult` now live in the promise adapter and still ship from the package root; `makeDatabase` returns the raw Effect database without the promise wrapper.
