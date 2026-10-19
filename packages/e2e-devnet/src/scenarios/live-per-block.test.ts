import { Cl } from "@stacks/transactions";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import {
  blockHash,
  chainTip,
  DEPLOYER_ADDRESS,
  EVENTS_CONTRACT,
  LEDGER_CONTRACT,
  RUNTIME_SENDER,
  submitContractCall,
  waitUntil,
} from "../chain.ts";
import { createDevnetIndexer, tracedFilters, waitForPhase } from "../indexer.ts";

/**
 * Live sync fetches a new block per block only when that costs fewer requests
 * than one logs page per syncing contract: a block costs its transaction count
 * plus one. Right after boot, Clarinet's sBTC funding mines a block of 10
 * deposits (cost 11) that a scenario's transactions may share. The contracts
 * past `LEDGER_CONTRACT` are watched only to raise the per-contract cost above
 * that; the scenario never calls them.
 */
const BOOT_CONTRACTS = [
  "pox",
  "pox-2",
  "pox-3",
  "pox-4",
  "bns",
  "costs",
  "costs-2",
  "costs-3",
  "cost-voting",
  "lockup",
  "genesis",
  "signers",
  "signers-voting",
  "sip-031",
].map((name) => `ST000000000000000000002AMW42H.${name}`);

const WATCHED_CONTRACTS = [
  EVENTS_CONTRACT,
  LEDGER_CONTRACT,
  `${DEPLOYER_ADDRESS}.sbtc-token`,
  `${DEPLOYER_ADDRESS}.sbtc-registry`,
  `${DEPLOYER_ADDRESS}.sbtc-deposit`,
  ...BOOT_CONTRACTS,
];

/** Records the path of every request while passing it through to the real `fetch`. */
function recordRequestPaths(): string[] {
  const paths: string[] = [];
  const realFetch = globalThis.fetch;

  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    paths.push(new URL(input instanceof Request ? input.url : input).pathname);

    return realFetch(input, init);
  });

  return paths;
}

describe("live sync over the per-block path", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("delivers events of nested contract calls and nothing from aborted transactions", async () => {
    const paths = recordRequestPaths();
    const startBlock = (await chainTip()) + 1;
    const trace = createTraceCollector();

    await using indexer = await createDevnetIndexer({
      transport: "polling",
      pollingInterval: 500,
    });

    const live = indexer.live(
      tracedFilters(
        trace,
        WATCHED_CONTRACTS.map((contractId) => ({ contractId, startBlock })),
      ),
    );

    const endedEarly = live.then(() => {
      throw new Error("live() ended before it was closed");
    });

    const delivered = (txId: string) =>
      Promise.race([
        endedEarly,
        waitUntil(`the events of ${txId}`, () =>
          trace.getEvents().find((event) => event.txId === txId),
        ),
      ]);

    await Promise.race([endedEarly, waitForPhase(indexer, "live")]);

    // Contracts without events are not synced through the newest block by the
    // Backfill, so the first live pass fetches per contract. Index one block
    // First; later blocks qualify for the per-block path.
    const warmUp = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(39),
    ]);

    await delivered(warmUp.txId);

    const ledger = await submitContractCall(RUNTIME_SENDER, LEDGER_CONTRACT, "record", [
      Cl.uint(40),
    ]);

    const aborted = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "emit-then-fail");

    // Blocks are indexed in order: once this event arrives, the aborted
    // Transaction's block has been processed too.
    const last = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(41),
    ]);

    await delivered(last.txId);
    await indexer.close();
    await expect(live).resolves.toBeUndefined();

    expect(aborted.status).toBe("abort_by_response");
    expect(ledger.blockHeight).toBeLessThan(aborted.blockHeight);

    // The ledger transaction's block went through the per-block path.
    expect(paths).toContain(
      `/extended/v3/blocks/${await blockHash(ledger.blockHeight)}/transactions`,
    );
    expect(paths).toContain(`/extended/v3/transactions/${ledger.txId}/events`);

    // `ledger.record` prints, calls `events.set-value` (which prints), then prints again.
    expect(
      trace
        .getEvents()
        .filter((event) => event.txId === ledger.txId)
        .map((event) => [event.contractId, event.blockHeight, event.eventIndex, event.decoded]),
    ).toStrictEqual([
      [LEDGER_CONTRACT, ledger.blockHeight, 0, { event: "ledger-before", amount: 40n }],
      [
        EVENTS_CONTRACT,
        ledger.blockHeight,
        1,
        { event: "value-set", value: 40n, sender: RUNTIME_SENDER.address },
      ],
      [LEDGER_CONTRACT, ledger.blockHeight, 2, { event: "ledger-after", amount: 40n }],
    ]);

    // Every event of the called contracts comes from this scenario's
    // Successful transactions; the aborted one delivers nothing.
    const calledContracts = new Set([EVENTS_CONTRACT, LEDGER_CONTRACT]);

    expect(
      new Set(
        trace
          .getEvents()
          .filter((event) => calledContracts.has(event.contractId))
          .map((event) => event.txId),
      ),
    ).toStrictEqual(new Set([warmUp.txId, ledger.txId, last.txId]));
    expect(trace.getEvents().map((event) => event.txId)).not.toContain(aborted.txId);
    trace.assertChronologicalOrder();
  });
});
