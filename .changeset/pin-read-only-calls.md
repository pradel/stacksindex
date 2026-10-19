---
"stacksindex": patch
---

Fix `callReadOnly` reading the chain head instead of the event's block. The node pins read-only calls by index block hash and ignores a block height, so heights are now resolved to their index block hash first (once per height per indexing batch). `tip` also accepts an index block hash directly.
