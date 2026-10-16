---
"stacksindex": patch
---

Detect reorgs by checking the previous run's chain tip against the canonical chain instead of replaying the finality window on every run. Only a reorged range is refetched and replayed, and a reorg that replaces a finalized block now fails with `ReorgError`.
