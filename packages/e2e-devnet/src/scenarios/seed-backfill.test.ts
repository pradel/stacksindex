import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import type { Indexer, RunResult } from "stacksindex";
import { afterAll, beforeAll, describe, expect, test } from "vite-plus/test";

import { EVENTS_CONTRACT, waitUntil, WALLET_1 } from "../chain.ts";
import { createDevnetIndexer, printName, tracedFilters } from "../indexer.ts";
import {
  readSeedHistory,
  SEED_BATCH_SIZE,
  SEED_BATCHES,
  SEED_EVENTS_CONTRACT_EVENTS,
  type SeedHistory,
} from "../seed.ts";

describe("backfill of the seed history from the deployment block", () => {
  const trace = createTraceCollector();
  let indexer: Indexer;
  let seed: SeedHistory;
  let result: RunResult;

  beforeAll(async () => {
    seed = await waitUntil("the seed history", readSeedHistory);
    indexer = await createDevnetIndexer();
    // No startBlock: the indexer has to find the first event itself.
    result = await indexer.run(
      tracedFilters(trace, [{ contractId: EVENTS_CONTRACT, endBlock: seed.endHeight }]),
    );
  });

  afterAll(async () => {
    await indexer.close();
  });

  test("indexes every seed event in chain order", async () => {
    const events = trace.getEvents();
    const countsByName = Object.groupBy(events, printName);

    expect(result.contracts).toMatchObject([
      {
        contractId: EVENTS_CONTRACT,
        status: "completed",
        eventsProcessed: SEED_EVENTS_CONTRACT_EVENTS,
      },
    ]);
    expect(result.eventsProcessed).toBe(SEED_EVENTS_CONTRACT_EVENTS);
    expect(events).toHaveLength(SEED_EVENTS_CONTRACT_EVENTS);
    expect(
      Object.fromEntries(
        Object.entries(countsByName).map(([name, group]) => [name, group?.length]),
      ),
    ).toStrictEqual({ "all-types": 1, "value-set": 3, batch: 150 });
    // `value-set` events follow the order of the deployment plan batches.
    expect(countsByName["value-set"]?.map((event) => event.valueRepr)).toStrictEqual([
      expect.stringContaining("(value u1)"),
      expect.stringContaining("(value u2)"),
      expect.stringContaining("(value u3)"),
    ]);

    for (const event of events) {
      expect(event.contractId).toBe(EVENTS_CONTRACT);
      expect(event.topic).toBe("print");
      expect(event.blockHeight).toBeGreaterThanOrEqual(seed.deployHeight);
      expect(event.blockHeight).toBeLessThanOrEqual(seed.endHeight);
    }

    trace.assertChronologicalOrder();

    const status = await indexer.status();

    expect(status.phase).toBe("done");
    expect(status.contracts).toStrictEqual([
      { contractId: EVENTS_CONTRACT, syncedBlockHeight: seed.endHeight, isComplete: true },
    ]);
  });

  test("follows contract logs across pages without gaps or duplicates", () => {
    const events = trace.getEvents();
    const batchEvents = events.filter((event) => printName(event) === "batch");

    // The logs endpoint returns at most 100 events per page.
    expect(result.contracts[0].pagesFetched).toBeGreaterThan(1);
    expect(new Set(events.map((event) => `${event.txId}:${event.eventIndex}`)).size).toBe(
      SEED_EVENTS_CONTRACT_EVENTS,
    );

    for (const batch of SEED_BATCHES) {
      expect(
        batchEvents
          .filter((event) => event.valueRepr.includes(`(batch u${batch})`))
          .map((event) => event.decoded),
      ).toStrictEqual(
        Array.from({ length: SEED_BATCH_SIZE }, (_, index) => ({
          event: "batch",
          batch,
          index: BigInt(index),
        })),
      );
    }
  });

  test("decodes every Clarity value type of a print event", () => {
    const [event] = trace.getEvents().filter((candidate) => printName(candidate) === "all-types");

    expect(event.senderAddress).toBe(WALLET_1.address);
    expect(event.decoded).toStrictEqual({
      event: "all-types",
      uint: 340282366920938463463374607431768211455n,
      int: -170141183460469231731687303715884105728n,
      bool: true,
      "standard-principal": WALLET_1.address,
      "contract-principal": EVENTS_CONTRACT,
      buff: "0xdeadbeef",
      ascii: "hello devnet",
      utf8: "café 🚀",
      some: 7n,
      none: null,
      ok: { ok: 1n },
      err: { error: 3n },
      list: [1n, 2n, 3n],
      tuple: { nested: { depth: 2n } },
    });
  });
});
