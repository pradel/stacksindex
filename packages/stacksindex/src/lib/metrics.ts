import { Metric } from "effect";

export const syncPages = Metric.counter("stacksindex.sync.pages", {
  description: "Contract-log pages fetched from the Stacks API",
  incremental: true,
});

export const syncEvents = Metric.counter("stacksindex.sync.events", {
  description: "Smart contract log events stored in the sync store",
  incremental: true,
});

export const syncErrors = Metric.counter("stacksindex.sync.errors", {
  description: "Errors raised while syncing historical data",
  incremental: true,
});

export const indexBatchDuration = Metric.histogram("stacksindex.index.batch_duration", {
  description: "Duration of one indexing batch in milliseconds",
  boundaries: [10, 50, 100, 500, 1_000, 5_000],
});
