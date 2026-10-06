---
"stacksindex": minor
---

Decode runtime boundaries with Schema and type every layer error.

- `HistoricalRuntime.layer` now fails with `ConfigurationError` in the Effect error channel instead of throwing synchronously when options are invalid.
- Filter input is decoded with a `FilterSchema` (non-negative safe integer block heights, `"latest"` end blocks, and start/end ordering) instead of a hand-rolled validation loop.
- Events read from the sync store are validated into a `StoredEvent` before handlers run, removing the `smart_contract_log` type assertion.
- `parseLogsCursor` and `parseTransactionCursor` now return `Effect<Cursor, InvalidCursorError>` instead of throwing.
- `IndexerDatabase.layer`, `makeDatabase`, `migrate`, and `IndexerDatabase.transaction` expose typed `DatabaseError` / `MigrationError` failures instead of `unknown`.
- Export `ConfigurationError`, `DatabaseError`, `InvalidCursorError`, and `MigrationError` from both `stacksindex` and `stacksindex/effect`.
