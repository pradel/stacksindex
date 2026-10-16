---
"stacksindex": minor
---

Add live sync and rename the runtime to `Indexer`.

**Breaking:** `createHistoricalRuntime` is now `createIndexer`, and the `HistoricalRuntime` service is now `Indexer` (`Indexer.layer`, `Indexer.layerWithDatabase`). The option and error types follow: `IndexerOptions`, `IndexerWithDatabaseOptions`, `IndexerService`, `IndexerError`. `finality` now defaults to `6` instead of `0`, so a reorg of the newest blocks is replayed instead of failing.

`indexer.live(filters)` runs the historical pass, then follows new blocks until every filter reached its `endBlock` (or until `close()` / fiber interruption). New blocks are detected by polling `GET /extended/v2/blocks` every `live.pollingInterval` (default 5000 ms) or, with `live.transport: "websocket"`, through the API's `/extended/v1/ws` block subscription, which falls back to polling after 9 consecutive connection failures. Each new head is fetched the cheaper way: block by block (block transactions, then each transaction's events) or contract by contract (each contract's newest logs page). A head built on the previous one skips the reorg request; otherwise a reorged range is replayed. API failures are retried with the next head and only fail `live` after 10 consecutive failures over 10 minutes.

`StacksClient` gains `getBlocks`. The package now requires Node.js 22 or later (global `WebSocket`).
