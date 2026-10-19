---
"stacksindex": minor
---

Fix `callReadOnly` reading the chain head instead of the event's block: the node pins read-only calls by index block hash and silently ignores a block height. Blocks now store their index block hash, handler events expose it as `index_block_hash`, and handler reads default to it. Breaking: `tip` on `callReadOnly`, `readOnly` and `StacksClient.callReadFunction` takes an index block hash (`string`) instead of a block height, and the migration refuses to run on an indexer database that already stores blocks: re-sync from an empty indexer database and reset the tables your handlers write to.
