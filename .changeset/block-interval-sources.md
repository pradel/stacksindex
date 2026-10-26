---
"stacksindex": minor
---

Add block interval sources: `defineIndexer({ blocks: { name: { interval, startBlock, endBlock } } })` runs a handler at every height `startBlock + k * interval` with a `BlockEvent`, its read-only calls pinned to that block. Within a block, prints are handled first, then block sources in definition order. `contracts` is now optional. `RunResult` and `IndexerStatus` gain `blocks`, `HandlerExecutionError.contractId` is absent for block sources, and block source metrics carry a `blocks` attribute. Adds the `stacksindex.block_sync_progress` table.
