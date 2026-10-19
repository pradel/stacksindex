---
"stacksindex": minor
---

Fix `callReadOnly` reading the chain head instead of the event's block. Breaking: `tip` takes an index block hash (`event.index_block_hash` for the event's block), and existing indexer databases must be re-synced.
