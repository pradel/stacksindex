---
"stacksindex": patch
---

Added a `finality` option that keeps a configurable number of trailing blocks unfinalized. Checkpoints now track a finalized block height, `RunResult` exposes it as `finalizedBlockHeight`, and unfinalized data is discarded and replayed after a restart so reorgs are handled automatically. Replayed handlers must be idempotent.
