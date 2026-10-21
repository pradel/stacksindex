import { Metric } from "effect";

/**
 * Every metric the indexer records. Names follow OpenTelemetry conventions
 * (dotted, no `_total` suffix): OTLP backends such as Prometheus append type
 * and unit suffixes themselves.
 *
 * `unit` is set through attributes because Effect's OTLP exporter reads it
 * from there; without it the unit defaults to `"1"`, which Prometheus turns
 * into a `_ratio` suffix on gauges. Curly-brace units are annotations that
 * Prometheus drops from the name.
 *
 * Every series also carries `chain_id`, applied once per `run`/`live` call
 * through `Metric.CurrentMetricAttributes`. Metrics with per-contract series
 * take the `contract` (definition name) and `contract_id` attributes from
 * `contractAttributes`: build the labelled metric once per contract with
 * `Metric.withAttributes`, not on every update.
 */

/** Attributes of a per-contract series: the definition name and the contract id. */
export const contractAttributes = (name: string, contractId: string) => ({
  contract: name,
  contract_id: contractId,
});

/** Millisecond buckets for I/O-bound work. */
const DURATION_MS_BOUNDARIES = [
  1, 5, 10, 50, 100, 500, 1_000, 5_000, 10_000, 50_000, 100_000, 500_000,
];

/** Millisecond buckets for handler calls, which are often sub-millisecond. */
const HANDLER_DURATION_MS_BOUNDARIES = [
  0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50, 100, 500, 1_000, 5_000, 10_000, 50_000,
];

const BLOCK = { unit: "{block}" };

const MILLISECONDS = { unit: "ms" };

// Stacks API

/**
 * One logical request, retries included. Attributes: `endpoint` (the
 * `StacksClient` method name, never the URL path, which embeds tx ids and
 * hashes) and `outcome` (`success` | `failure`).
 */
export const apiRequestDuration = Metric.histogram("stacksindex.api.request.duration", {
  description: "Duration of a Stacks API request including retries, in milliseconds",
  boundaries: DURATION_MS_BOUNDARIES,
  attributes: MILLISECONDS,
});

/**
 * One HTTP attempt, recorded below the rate limiter so retried 429s count.
 * Attributes: `endpoint`, `status` (`2xx` | `3xx` | `4xx` | `429` | `5xx` |
 * `network`).
 */
export const apiResponses = Metric.counter("stacksindex.api.responses", {
  description: "HTTP attempts against the Stacks API by status class",
  incremental: true,
});

// Historical sync

/** Attributes: `contract`, `kind` (`backfill` | `catchup`). */
export const syncPages = Metric.counter("stacksindex.sync.pages", {
  description: "Contract-log pages fetched from the Stacks API",
  incremental: true,
});

/** Attributes: `contract`. */
export const syncTransactions = Metric.counter("stacksindex.sync.transactions", {
  description: "Transactions fetched to give stored events their context",
  incremental: true,
});

/** Attributes: `contract`, `path` (`historical` | `block`). */
export const syncEvents = Metric.counter("stacksindex.sync.events", {
  description: "Smart contract log events stored in the sync store",
  incremental: true,
});

/** Attributes: `mode` (`historical` | `live`). */
export const syncErrors = Metric.counter("stacksindex.sync.errors", {
  description: "Failed sync passes",
  incremental: true,
});

/** Attributes: `contract`. Mirrors `sync_progress.synced_block_height`. */
export const syncBlock = Metric.gauge("stacksindex.sync.block", {
  description: "Height up to which every event of the contract is stored",
  attributes: BLOCK,
});

/** Attributes: `contract`. 1 once the contract reached its `endBlock`. */
export const syncComplete = Metric.gauge("stacksindex.sync.complete", {
  description: "Whether the contract synced through its endBlock (0 or 1)",
  attributes: { unit: "{boolean}" },
});

/** Blocks the current historical pass must cover, across contracts. */
export const historicalTotalBlocks = Metric.gauge("stacksindex.historical.total_blocks", {
  description: "Blocks the current historical pass must cover",
  attributes: BLOCK,
});

/** Blocks the current historical pass has covered, across contracts. */
export const historicalCompletedBlocks = Metric.gauge("stacksindex.historical.completed_blocks", {
  description: "Blocks the current historical pass has covered",
  attributes: BLOCK,
});

/** Chain tip read at the start of the latest pass (the sync anchor). */
export const chainTipBlock = Metric.gauge("stacksindex.chain.tip_block", {
  description: "Chain tip height read at the start of the latest pass",
  attributes: BLOCK,
});

// Indexing

/** Mirrors `checkpoints.block_height`. */
export const indexingBlock = Metric.gauge("stacksindex.indexing.block", {
  description: "Height through which every event has been indexed",
  attributes: BLOCK,
});

/** Mirrors `checkpoints.block_time`, in Unix seconds. */
export const indexingBlockTimestamp = Metric.gauge("stacksindex.indexing.block_timestamp", {
  description: "Block time of the indexing checkpoint, in Unix seconds",
  attributes: { unit: "s" },
});

/** Mirrors `checkpoints.finalized_block_height`. */
export const indexingFinalizedBlock = Metric.gauge("stacksindex.indexing.finalized_block", {
  description: "Highest indexed block that is final",
  attributes: BLOCK,
});

/** Attributes: `contract`. Incremented once per committed batch. */
export const indexingEvents = Metric.counter("stacksindex.indexing.events", {
  description: "Events passed to handlers in committed batches",
  incremental: true,
});

/** Attributes: `contract`. */
export const indexingHandlerDuration = Metric.histogram("stacksindex.indexing.handler.duration", {
  description: "Duration of one handler call, in milliseconds",
  boundaries: HANDLER_DURATION_MS_BOUNDARIES,
  attributes: MILLISECONDS,
});

/** Attributes: `contract`. */
export const indexingHandlerErrors = Metric.counter("stacksindex.indexing.handler.errors", {
  description: "Handler calls that failed",
  incremental: true,
});

/** One batch: handlers plus the checkpoint, in one database transaction. */
export const indexingBatchDuration = Metric.histogram("stacksindex.indexing.batch.duration", {
  description: "Duration of one indexing batch, in milliseconds",
  boundaries: DURATION_MS_BOUNDARIES,
  attributes: MILLISECONDS,
});

// Live sync

/** 1 while `live` follows new heads, 0 otherwise. */
export const liveIsRealtime = Metric.gauge("stacksindex.live.is_realtime", {
  description: "Whether live sync is following new blocks (0 or 1)",
  attributes: { unit: "{boolean}" },
});

/** Latest head received from the heads stream. */
export const liveHeadBlock = Metric.gauge("stacksindex.live.head_block", {
  description: "Height of the latest chain head received",
  attributes: BLOCK,
});

/** Time between a block's timestamp and its head being processed. */
export const liveBlockArrivalLatency = Metric.histogram("stacksindex.live.block_arrival_latency", {
  description: "Time between a block's timestamp and its head being processed, in milliseconds",
  boundaries: DURATION_MS_BOUNDARIES,
  attributes: MILLISECONDS,
});

/** Attributes: `fetch` (`blocks` | `contracts`). */
export const livePassDuration = Metric.histogram("stacksindex.live.pass.duration", {
  description: "Duration of one live pass (fetch, store and index), in milliseconds",
  boundaries: DURATION_MS_BOUNDARIES,
  attributes: MILLISECONDS,
});

/** Mirrors the live failure budget; `live` fails once it is exhausted. */
export const liveConsecutiveFailures = Metric.gauge("stacksindex.live.consecutive_failures", {
  description: "Consecutive failed live passes",
  attributes: { unit: "{failure}" },
});

export const liveWebSocketReconnects = Metric.counter("stacksindex.live.websocket.reconnects", {
  description: "Websocket reconnection attempts for new heads",
  incremental: true,
});

export const liveTransportFallbacks = Metric.counter("stacksindex.live.transport_fallbacks", {
  description: "Switches from the websocket transport to polling",
  incremental: true,
});

export const liveStalls = Metric.counter("stacksindex.live.stalls", {
  description: "Times no new head arrived within the stall window",
  incremental: true,
});

// Reorgs

export const reorgs = Metric.counter("stacksindex.reorgs", {
  description: "Chain reorganizations that replaced stored blocks",
  incremental: true,
});

/** Blocks rewound and replayed by one reorg. */
export const reorgDepth = Metric.histogram("stacksindex.reorg.depth", {
  description: "Blocks rewound and replayed by one reorg",
  boundaries: [1, 2, 3, 5, 10, 20, 50, 100],
  attributes: BLOCK,
});
