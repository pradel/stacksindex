---
"stacksindex": patch
---

Detect reorgs instead of replaying the finality window on every run. Each run saves the chain tip it read (`sync_anchors`) and, at the next run, compares that block's hash with the canonical chain: one request. When it still matches, nothing is replayed. When a reorg replaced it, a binary search over the stored blocks finds the newest one that is still canonical, and only the range above it is refetched and replayed through handlers.

A reorg that replaces a block at or below `finalizedBlockHeight` now fails the run with the new `ReorgError` instead of leaving orphaned data in place silently. `finality` therefore sets how deep a reorg may go before it is treated as fatal; with the default `0`, any reorg that reaches indexed blocks fails the run.

`syncStore.rewindToFinalized` is replaced by `syncStore.rewindTo({ chainId, blockHeight })`.
