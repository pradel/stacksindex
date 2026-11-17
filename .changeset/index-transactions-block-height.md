---
"stacksindex": patch
---

Index `stacksindex.transactions` by block height. Every pass, including each new block in `live`, deletes transactions above the anchor, which scanned the whole table. The index is built once when the database opens; on a large Postgres sync store this can take a while.
