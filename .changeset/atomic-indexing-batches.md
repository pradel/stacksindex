---
"stacksindex": patch
---

Improved crash recovery by committing each indexed event batch and its checkpoint in a single database transaction. A crash while processing a batch no longer replays events that were already handled.
