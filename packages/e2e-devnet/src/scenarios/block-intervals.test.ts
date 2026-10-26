import { Cl } from "@stacks/transactions";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import { describe, expect, test } from "vite-plus/test";

import {
  chainTip,
  EVENTS_CONTRACT,
  getBlock,
  RUNTIME_SENDER,
  submitContractCall,
  type ConfirmedTransaction,
} from "../chain.ts";
import { contractName, createDevnetIndexer, waitForPhase } from "../indexer.ts";

const POLLING_INTERVAL = 500;

/** Heights from `start` through `end`, `step` apart. */
function heightsFrom(start: number, end: number, step: number): number[] {
  return Array.from({ length: Math.floor((end - start) / step) + 1 }, (_, k) => start + k * step);
}

/**
 * Sends one transaction at a time, each mined in a new block, until `live`
 * resolves; returns the mined transactions. Every sent transaction is awaited
 * so the sender nonce stays in order for the next scenario.
 */
async function mineUntil(live: Promise<void>): Promise<ConfirmedTransaction[]> {
  const ended = live.then(() => true);
  const mined: ConfirmedTransaction[] = [];

  for (let value = 40; ; value += 1) {
    const transaction = submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(value),
    ]);

    const done = await Promise.race([ended, transaction.then(() => false)]);

    mined.push(await transaction);

    if (done) {
      return mined;
    }
  }
}

describe("block interval sources across backfill and live sync", () => {
  test("run at every matching height, after the block's prints, until endBlock", async () => {
    // Heights up to the tip are backfilled; the rest arrive while live. An idle
    // Devnet mines slowly, so each transaction below gets the next block.
    const tip = await chainTip();
    const startBlock = tip - 4;
    const endBlock = tip + 4;
    const trace = createTraceCollector();

    await using indexer = await createDevnetIndexer({
      trace,
      contracts: [{ contractId: EVENTS_CONTRACT, startBlock: tip + 1, endBlock }],
      blocks: {
        EveryBlock: { startBlock, endBlock },
        EveryOther: { interval: 2, startBlock: startBlock + 1, endBlock },
      },
      live: { transport: "polling", pollingInterval: POLLING_INTERVAL },
    });

    const live = indexer.live();

    await Promise.race([
      live.then(() => {
        throw new Error("live() reached endBlock before following new heads");
      }),
      waitForPhase(indexer, "live"),
    ]);

    const mined = await mineUntil(live);

    const blockEvents = trace.getBlockEvents();

    const heightsOf = (name: string) =>
      blockEvents.filter((event) => event.name === name).map((event) => event.blockHeight);

    expect(heightsOf("EveryBlock")).toStrictEqual(heightsFrom(startBlock, endBlock, 1));
    expect(heightsOf("EveryOther")).toStrictEqual(heightsFrom(startBlock + 1, endBlock, 2));

    // Each run carries the canonical block the API reports at its height.
    const apiBlocks = await Promise.all(
      heightsFrom(startBlock, endBlock, 1).map((height) => getBlock(height)),
    );

    expect(blockEvents).toStrictEqual(
      blockEvents.map((event) => {
        const block = apiBlocks[event.blockHeight - startBlock];

        return {
          name: event.name,
          blockHeight: block.height,
          blockTime: block.burn_block_time,
          hash: block.hash,
          indexBlockHash: block.index_block_hash,
        };
      }),
    );

    // Handlers run in height order; within a block, prints come before the
    // Block sources.
    const sequence = trace.getSequence();

    const orderKey = (entry: (typeof sequence)[number]) =>
      entry.blockHeight * 2 + ["print", "block"].indexOf(entry.type);

    expect(sequence).toStrictEqual(
      sequence.toSorted((left, right) => orderKey(left) - orderKey(right)),
    );

    // Every transaction mined through endBlock printed its event.
    const indexedTxIds = new Set(trace.getEvents().map((event) => event.txId));
    const minedThroughEnd = mined.filter((transaction) => transaction.blockHeight <= endBlock);

    expect(minedThroughEnd.length).toBeGreaterThan(0);
    expect(
      minedThroughEnd.filter((transaction) => !indexedTxIds.has(transaction.txId)),
    ).toStrictEqual([]);

    const status = await indexer.status();

    expect(status.phase).toBe("done");
    expect(status.blocks).toStrictEqual({
      EveryBlock: { syncedBlockHeight: endBlock, isComplete: true },
      EveryOther: { syncedBlockHeight: endBlock, isComplete: true },
    });
    expect(status.contracts).toMatchObject({
      [contractName(EVENTS_CONTRACT)]: { syncedBlockHeight: endBlock },
    });
  });
});
