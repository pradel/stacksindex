---
"stacksindex": minor
---

Add monitoring: `telemetry.otlp` pushes metrics for the Stacks API, sync, indexing, live sync and reorgs over OTLP, and `indexer.status()` reports the phase, readiness and progress. Breaking: `stacksindex.index.batch_duration` is renamed to `stacksindex.indexing.batch.duration`, and every metric now carries a `chain_id` attribute.
