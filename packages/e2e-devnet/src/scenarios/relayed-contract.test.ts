import { Cl } from "@stacks/transactions";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import { describe, expect, test } from "vite-plus/test";

import {
  chainTip,
  RELAY_CONTRACT,
  RELAYED_CONTRACT,
  RUNTIME_SENDER,
  submitContractCall,
} from "../chain.ts";
import { createDevnetIndexer, printName, tracedFilters } from "../indexer.ts";

describe("a contract only reached through another contract", () => {
  test("indexes its events although no transaction calls it directly", async () => {
    const startBlock = (await chainTip()) + 1;
    const first = await submitContractCall(RUNTIME_SENDER, RELAY_CONTRACT, "relay", [Cl.uint(1)]);
    const second = await submitContractCall(RUNTIME_SENDER, RELAY_CONTRACT, "relay", [Cl.uint(2)]);

    const trace = createTraceCollector();
    await using indexer = await createDevnetIndexer();

    const result = await indexer.run(
      tracedFilters(trace, [
        { contractId: RELAYED_CONTRACT, startBlock, endBlock: second.blockHeight },
      ]),
    );

    // Its own logs list both prints, while its address history lists neither
    // Transaction: they only call `relay`.
    expect(
      trace.getEvents().map((event) => [event.txId, printName(event), event.valueRepr]),
    ).toStrictEqual([
      [first.txId, "relayed", expect.stringContaining("(amount u1)")],
      [second.txId, "relayed", expect.stringContaining("(amount u2)")],
    ]);
    expect(result.contracts).toMatchObject([{ contractId: RELAYED_CONTRACT, status: "completed" }]);
  });
});
