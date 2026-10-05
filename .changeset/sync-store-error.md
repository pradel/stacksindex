---
"stacksindex": minor
---

Add `SyncStoreError` and surface sync-store failures through `runtime.run()`.

- Sync-store operations throw `SyncStoreError` with the failing `operation` and the original `cause`.
- `createHistoricalRuntime().run()` returns `Result.err(new SyncStoreError(...))` instead of rejecting when a sync-store operation fails.
