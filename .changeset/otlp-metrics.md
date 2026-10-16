---
"stacksindex": minor
---

Add monitoring: the new `telemetry.otlp` option (`baseUrl`, `headers`, `exportInterval`, `temporality`, `resource`) on `createIndexer` and `Indexer.layerWithDatabase` pushes metrics over OTLP/HTTP to an OpenTelemetry Collector, Prometheus (`--web.enable-otlp-receiver`) or any OTLP backend, and `close()` flushes the last snapshot. The indexer now records metrics for Stacks API requests, sync progress, indexing, live sync and reorgs (see the Monitoring section of the README), and `indexer.status()` (`Indexer.status` in Effect) reports the phase, readiness, checkpoint, sync anchor and per-contract progress for readiness probes. Breaking for existing dashboards: `stacksindex.index.batch_duration` is renamed to `stacksindex.indexing.batch.duration`, every series carries a `chain_id` attribute, `stacksindex.sync.pages` and `stacksindex.sync.events` gain `contract` plus `kind`/`path` attributes, and `stacksindex.sync.errors` gains `mode`.
