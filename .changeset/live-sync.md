---
"stacksindex": minor
---

Add live sync: `indexer.live(filters)` runs the historical sync, then indexes new blocks as they arrive, detected by polling (default) or the API websocket (`live.transport`). Breaking: `createHistoricalRuntime` and `HistoricalRuntime` are renamed to `createIndexer` and `Indexer`, `finality` defaults to `6`, and Node.js 22 or later is required.
