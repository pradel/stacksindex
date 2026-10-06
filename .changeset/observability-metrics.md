---
"stacksindex": patch
---

Added Effect metrics for historical sync and indexing (`stacksindex.sync.pages`, `stacksindex.sync.events`, `stacksindex.sync.errors`, `stacksindex.index.batch_duration`), per-phase log annotations (`fetch`, `store`, `index`, `checkpoint`), and `pagesFetched`/`transactionsFetched` counters on `ContractRunResult`.
