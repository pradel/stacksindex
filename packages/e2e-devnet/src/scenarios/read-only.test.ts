import { Cl } from "@stacks/transactions";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import type { ClarityJsonValue } from "stacksindex/clarity";
import { describe, expect, test } from "vite-plus/test";

import { chainTip, EVENTS_CONTRACT, RUNTIME_SENDER, submitContractCall } from "../chain.ts";
import { createDevnetIndexer, printField } from "../indexer.ts";

describe("callReadOnly from a handler", () => {
  test("reads contract state as of the event's block", async () => {
    const startBlock = (await chainTip()) + 1;

    const first = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(1000),
    ]);

    const second = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(2000),
    ]);

    const trace = createTraceCollector();
    const reads: ClarityJsonValue[] = [];
    await using indexer = await createDevnetIndexer();

    expect(second.blockHeight).toBeGreaterThan(first.blockHeight);

    await indexer.run({
      contractId: EVENTS_CONTRACT,
      startBlock,
      endBlock: second.blockHeight,
      handler: async (event, { client }) => {
        trace.record(EVENTS_CONTRACT, event);
        reads.push(
          await client.callReadOnly({ contractId: EVENTS_CONTRACT, functionName: "get-value" }),
        );
      },
    });

    expect(trace.getEvents().map((event) => printField(event, "value"))).toStrictEqual([
      1000n,
      2000n,
    ]);
    // The chain head holds 2000: reading the head for the first event would return 2000.
    expect(reads).toStrictEqual([1000n, 2000n]);
  });
});
