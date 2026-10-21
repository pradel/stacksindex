import { Cl } from "@stacks/transactions";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import { describe, expect, test } from "vite-plus/test";

import { chainTip, EVENTS_CONTRACT, RUNTIME_SENDER, submitContractCall } from "../chain.ts";
import { createDevnetIndexer, printName } from "../indexer.ts";

describe("aborted transactions", () => {
  test("store no events, even when they printed before aborting", async () => {
    const startBlock = (await chainTip()) + 1;
    const aborted = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "emit-then-fail");

    const succeeded = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(7),
    ]);

    const trace = createTraceCollector();

    await using indexer = await createDevnetIndexer({
      trace,
      contracts: [{ contractId: EVENTS_CONTRACT, startBlock, endBlock: succeeded.blockHeight }],
    });

    expect(aborted.status).toBe("abort_by_response");
    expect(succeeded.status).toBe("success");

    await indexer.run();

    expect(
      trace.getEvents().map((event) => [event.txId, printName(event), event.valueRepr]),
    ).toStrictEqual([[succeeded.txId, "value-set", expect.stringContaining("(value u7)")]]);
  });
});
