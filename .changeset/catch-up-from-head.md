---
"stacksindex": patch
---

Fix historical sync stopping before a contract's newest events and make re-runs cheap.

The logs endpoint returns no `next_cursor` once fewer than a full page (100) of newer events exists, and the sync treated that as caught up. Up to 99 events per contract were left unfetched, each later run picked up one more block of them, and those late events landed below the indexing checkpoint so handlers never received them. Sync now finishes every contract by fetching its newest page and walking `prev_cursor` back to what is stored.

A caught-up contract is now checked with a single request instead of re-running first-event discovery (contract, principal transactions, transaction events and v1 transaction lookups) and re-fetching a page on every run. Reorg rewinds use the same catch-up instead of rediscovery. Indexing within a run is capped at the chain tip read before syncing, so events mined during a run are delivered by the next one in chain order.

`sync_progress.lastBlockHeight` is renamed to `syncedBlockHeight` (every event at or below it is stored), and `syncStore.upsertSyncProgress` takes `syncedBlockHeight`. The migration converts existing rows, but events skipped by the previous behavior sit below the checkpoint and are not replayed: re-sync from an empty indexer database (and reset handler tables) to recover them.
