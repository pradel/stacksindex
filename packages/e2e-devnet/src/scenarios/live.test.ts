import { Cl } from "@stacks/transactions";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import type { LiveOptions } from "stacksindex";
import { describe, expect, test } from "vite-plus/test";

import {
  callContract,
  chainTip,
  EVENTS_CONTRACT,
  RUNTIME_SENDER,
  submitContractCall,
  waitUntil,
} from "../chain.ts";
import { createDevnetIndexer, contractName, waitForPhase } from "../indexer.ts";

const POLLING_INTERVAL = 500;

describe.each<NonNullable<LiveOptions["transport"]>>(["polling", "websocket"])(
  "live sync over %s",
  (transport) => {
    test("indexes transactions mined after live sync started", async () => {
      const startBlock = (await chainTip()) + 1;
      const trace = createTraceCollector();

      await using indexer = await createDevnetIndexer({
        trace,
        contracts: [{ contractId: EVENTS_CONTRACT, startBlock }],
        live: { transport, pollingInterval: POLLING_INTERVAL },
      });

      const live = indexer.live();

      const endedEarly = live.then(() => {
        throw new Error("live() ended before it was closed");
      });

      await Promise.race([endedEarly, waitForPhase(indexer, "live")]);

      const transaction = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
        Cl.uint(20),
      ]);

      const event = await Promise.race([
        endedEarly,
        waitUntil("the live event", () =>
          trace.getEvents().find((candidate) => candidate.txId === transaction.txId),
        ),
      ]);

      expect(event.blockHeight).toBe(transaction.blockHeight);
      expect(event.valueRepr).toContain("(value u20)");

      await indexer.close();
      await expect(live).resolves.toBeUndefined();
    });
  },
);

describe("live sync with an endBlock", () => {
  test("resolves once the chain reaches endBlock", async () => {
    // Two blocks ahead: an idle devnet mines blocks slowly (3 took ~170s), so
    // The backfill ends below it and `live` must follow new heads. Each
    // Transaction then gets the next block mined within seconds.
    const endBlock = (await chainTip()) + 2;
    const trace = createTraceCollector();

    await using indexer = await createDevnetIndexer({
      trace,
      contracts: [{ contractId: EVENTS_CONTRACT, startBlock: endBlock, endBlock }],
      live: { pollingInterval: POLLING_INTERVAL },
    });

    const live = indexer.live();

    await Promise.race([
      live.then(() => {
        throw new Error("live() reached endBlock before following new heads");
      }),
      waitForPhase(indexer, "live"),
    ]);
    await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [Cl.uint(30)]);
    await callContract(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [Cl.uint(31)]);
    await live;

    const status = await indexer.status();

    expect(status.phase).toBe("done");
    expect(status.anchor?.blockHeight).toBeGreaterThanOrEqual(endBlock);
    expect(status.contracts).toMatchObject({
      [contractName(EVENTS_CONTRACT)]: { syncedBlockHeight: endBlock },
    });
  });
});
