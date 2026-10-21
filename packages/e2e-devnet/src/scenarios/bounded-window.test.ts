import { createTraceCollector, type RecordedTraceEvent } from "indexer-e2e/src/tracer.ts";
import { describe, expect, test } from "vite-plus/test";

import { EVENTS_CONTRACT, waitUntil } from "../chain.ts";
import { createDevnetIndexer, printField } from "../indexer.ts";
import { readSeedHistory } from "../seed.ts";

async function indexEvents(startBlock?: number, endBlock?: number): Promise<RecordedTraceEvent[]> {
  const trace = createTraceCollector();

  await using indexer = await createDevnetIndexer({
    trace,
    contracts: [{ contractId: EVENTS_CONTRACT, startBlock, endBlock }],
  });

  await indexer.run();

  return trace.getEvents();
}

function eventKeys(events: RecordedTraceEvent[], startBlock: number, endBlock: number): string[] {
  return events.flatMap((event) =>
    event.blockHeight >= startBlock && event.blockHeight <= endBlock
      ? [`${event.blockHeight}:${event.txIndex}:${event.eventIndex}:${event.txId}`]
      : [],
  );
}

function batchBlock(events: RecordedTraceEvent[], batch: bigint): number {
  const event = events.find((candidate) => printField(candidate, "batch") === batch);

  if (event === undefined) {
    throw new Error(`The seed history has no events of batch ${batch}`);
  }

  return event.blockHeight;
}

describe("startBlock and endBlock", () => {
  test("index exactly the events inside the window", async () => {
    const seed = await waitUntil("the seed history", readSeedHistory);
    const allEvents = await indexEvents(undefined, seed.endHeight);
    const batchHeight = batchBlock(allEvents, 2n);

    const windows = [
      [batchHeight, batchHeight],
      [seed.deployHeight, batchHeight - 1],
      [batchHeight + 1, seed.endHeight],
    ];

    for (const [startBlock, endBlock] of windows) {
      const windowEvents = await indexEvents(startBlock, endBlock);

      expect(
        eventKeys(windowEvents, -Infinity, Infinity),
        `window ${startBlock}-${endBlock}`,
      ).toStrictEqual(eventKeys(allEvents, startBlock, endBlock));
    }

    // The single-block window holds all 50 events of the `batch u2` call.
    expect(
      (await indexEvents(batchHeight, batchHeight)).filter(
        (event) => printField(event, "batch") === 2n,
      ),
    ).toHaveLength(50);
  });
});
