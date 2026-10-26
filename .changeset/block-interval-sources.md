---
"stacksindex": minor
---

Add block interval sources: `defineIndexer({ blocks: { name: { interval, startBlock, endBlock } } })` runs a handler at every height `startBlock + k * interval` with a `BlockEvent` (its `name` typed by the source key), its read-only calls pinned to that block. Within a block, prints are handled first, then block sources in definition order. `contracts` is now optional. `RunResult` and `IndexerStatus` gain `blocks`, a failing block handler raises the new `BlockHandlerExecutionError`, and block source metrics carry a `blocks` attribute. A run warns when a contract or block source added after indexing started would skip history. Indexing now reads stored rows in bounded pages. Adds the `stacksindex.block_sync_progress` table.
