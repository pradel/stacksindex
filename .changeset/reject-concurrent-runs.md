---
"stacksindex": minor
---

Breaking: `run` and `live` reject with the new `IndexerBusyError` when another `run` or `live` of the same indexer is in progress. Overlapping passes previously ran handlers for the same events twice. Run one indexer per database: separate `create` or `layer` calls on the same database are not coordinated, even within one process.
