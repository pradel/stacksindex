---
"stacksindex": minor
---

`run` and `live` fail with `ConfigurationError` when the contracts changed in a way that would leave events unindexed: adding a contract whose events are in blocks that were already processed, or changing the `startBlock` or `endBlock` of a contract after indexing started. Before, those events were silently skipped. The contracts are recorded in a new `stacksindex.meta` table; an existing database records its current contracts on the first run. Removing or renaming a contract is still accepted.
