---
"stacksindex": patch
---

Fix historical sync skipping events of contracts that are only called through other contracts. The first page to sync is now found from the contract's own event logs instead of the transactions sent to it.
