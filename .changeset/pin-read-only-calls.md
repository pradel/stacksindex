---
"stacksindex": minor
---

Fix `callReadOnly` reading the chain head instead of the event's block: the node pins read-only calls by index block hash and silently ignores a block height. Handler reads are now pinned to the index block hash of the event's block (one block lookup per height per indexing batch). Breaking: `tip` on `callReadOnly`, `readOnly` and `StacksClient.callReadFunction` now takes an index block hash (`string`) instead of a block height.
