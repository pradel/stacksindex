import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import { describe, expect, test } from "vite-plus/test";

import { EVENTS_CONTRACT, LEDGER_CONTRACT, waitUntil } from "../chain.ts";
import { createDevnetIndexer, printName, tracedFilters } from "../indexer.ts";
import {
  readSeedHistory,
  SEED_EVENTS_CONTRACT_EVENTS,
  SEED_LEDGER_CONTRACT_EVENTS,
} from "../seed.ts";

describe("multiple contracts", () => {
  test("deliver events of both contracts in chain order, interleaved inside a transaction", async () => {
    const seed = await waitUntil("the seed history", readSeedHistory);
    const trace = createTraceCollector();
    await using indexer = await createDevnetIndexer();

    const result = await indexer.run(
      tracedFilters(trace, [
        { contractId: EVENTS_CONTRACT, endBlock: seed.endHeight },
        { contractId: LEDGER_CONTRACT, endBlock: seed.endHeight },
      ]),
    );

    const events = trace.getEvents();
    const [ledgerEvent] = trace.getEventsForContract(LEDGER_CONTRACT);

    expect(result.eventsProcessed).toBe(SEED_EVENTS_CONTRACT_EVENTS + SEED_LEDGER_CONTRACT_EVENTS);
    expect(trace.getEventsForContract(EVENTS_CONTRACT)).toHaveLength(SEED_EVENTS_CONTRACT_EVENTS);
    expect(trace.getEventsForContract(LEDGER_CONTRACT)).toHaveLength(SEED_LEDGER_CONTRACT_EVENTS);

    trace.assertChronologicalOrder();

    // `ledger.record` prints, calls `events.set-value` (which prints), then prints again.
    expect(
      events
        .filter((event) => event.txId === ledgerEvent.txId)
        .map((event) => [event.contractId, event.eventIndex, printName(event)]),
    ).toStrictEqual([
      [LEDGER_CONTRACT, 0, "ledger-before"],
      [EVENTS_CONTRACT, 1, "value-set"],
      [LEDGER_CONTRACT, 2, "ledger-after"],
    ]);
  });
});
