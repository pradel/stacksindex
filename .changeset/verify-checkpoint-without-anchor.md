---
"stacksindex": patch
---

A run that could not read the chain tip no longer makes the next run replay the unfinalized blocks through the handlers. With no saved chain tip, the next run checks the newest stored block at or below the checkpoint against the canonical chain, and replays only when a reorg replaced it.
