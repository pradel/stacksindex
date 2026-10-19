import { Cl } from "@stacks/transactions";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import { describe, expect, test } from "vite-plus/test";

import { chainTip, EVENTS_CONTRACT, RUNTIME_SENDER, submitContractCall } from "../chain.ts";
import { createDevnetIndexer, tracedFilters } from "../indexer.ts";

describe("resuming on the same database", () => {
  test("indexes only the events added since the previous run", async () => {
    const startBlock = (await chainTip()) + 1;

    const first = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(10),
    ]);

    const trace = createTraceCollector();
    await using indexer = await createDevnetIndexer();
    const filters = tracedFilters(trace, [{ contractId: EVENTS_CONTRACT, startBlock }]);

    const firstRun = await indexer.run(filters);

    expect(firstRun.eventsProcessed).toBe(1);
    expect(trace.getEvents().map((event) => event.txId)).toStrictEqual([first.txId]);

    trace.clear();

    const second = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(11),
    ]);

    const secondRun = await indexer.run(filters);

    expect(secondRun.eventsProcessed).toBe(1);
    expect(trace.getEvents().map((event) => event.txId)).toStrictEqual([second.txId]);

    trace.clear();

    const thirdRun = await indexer.run(filters);

    expect(thirdRun.eventsProcessed).toBe(0);
    expect(trace.getEvents()).toStrictEqual([]);
  });
});
