---
"stacksindex": minor
---

Breaking: the public exports are trimmed to the indexer API. Removed: `resolveChain` and the chain/API URL constants, `loggerLayer`, `StacksClient`, `readOnly` and their types, the read-only call parameter types, and the `FilterValidationError`, `SyncStoreError`, `InvalidCursorError` and `TransactionBatchError` classes (still reachable as `cause`). `IndexerError` is now exported from `stacksindex` too.
