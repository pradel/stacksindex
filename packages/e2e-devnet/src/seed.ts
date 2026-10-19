import {
  contractDeployHeight,
  EVENTS_CONTRACT,
  latestSentTransaction,
  WALLET_4,
  WALLET_5,
} from "./chain.ts";

/**
 * Seed history sent by `clarinet/deployments/default.devnet-plan.yaml`:
 * `emit-all-types`, three `value-set` prints (one through `ledger.record`) and
 * three `emit-batch` calls of 50 prints each.
 */
export const SEED_EVENTS_CONTRACT_EVENTS = 154;

export const SEED_LEDGER_CONTRACT_EVENTS = 2;

export const SEED_BATCHES = [1n, 2n, 3n];

export const SEED_BATCH_SIZE = 50;

export interface SeedHistory {
  /** Block that deployed `events.clar`. */
  deployHeight: number;
  /** Block of the last seed transaction. */
  endHeight: number;
}

/**
 * Reads where the seed history sits on the chain, or `undefined` while the
 * deployment plan is still running. The last plan batch is the only use of
 * wallet_4 and wallet_5, so their transactions mark the end of the seed.
 */
export async function readSeedHistory(): Promise<SeedHistory | undefined> {
  const lastTransactions = await Promise.all([
    latestSentTransaction(WALLET_4.address),
    latestSentTransaction(WALLET_5.address),
  ]);

  const heights: number[] = [];

  for (const transaction of lastTransactions) {
    if (transaction?.tx_status !== "success" || transaction.block_height === undefined) {
      return undefined;
    }

    heights.push(transaction.block_height);
  }

  return {
    deployHeight: await contractDeployHeight(EVENTS_CONTRACT),
    endHeight: Math.max(...heights),
  };
}
