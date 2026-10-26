import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import {
  broadcastTransaction,
  makeContractCall,
  PostConditionMode,
  type ClarityValue,
} from "@stacks/transactions";

/** Stacks-blockchain-api URL of the local Clarinet devnet (see `clarinet/settings/Devnet.toml`). */
export const LOCAL_DEVNET_API_URL = "http://localhost:3999";

export const DEVNET_API_URL = process.env.STACKS_DEVNET_API_URL ?? LOCAL_DEVNET_API_URL;

export const DEPLOYER_ADDRESS = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

export const EVENTS_CONTRACT = `${DEPLOYER_ADDRESS}.events`;

export const LEDGER_CONTRACT = `${DEPLOYER_ADDRESS}.ledger`;

export interface DevnetAccount {
  address: string;
  privateKey: string;
}

// Well-known devnet keys, copied from the comments in `clarinet/settings/Devnet.toml`.
// Wallet_1..wallet_5 send the seed history in the deployment plan; only the
// Seed may use them, so their latest transaction marks the end of the seed.
export const WALLET_1: DevnetAccount = {
  address: "ST1SJ3DTE5DN7X54YDH5D64R3BCB6A2AG2ZQ8YPD5",
  privateKey: "7287ba251d44a4d3fd9276c88ce34c5c52a038955511cccaf77e61068649c17801",
};

export const WALLET_4: DevnetAccount = {
  address: "ST2NEB84ASENDXKYGJPQW86YXQCEFEX2ZQPG87ND",
  privateKey: "f9d7206a47f14d2870c163ebab4bf3e70d18f5d14ce1031f3902fbbc894fe4c701",
};

export const WALLET_5: DevnetAccount = {
  address: "ST2REHHS5J3CERCRBEPMGH7921Q6PYKAADT7JP2VB",
  privateKey: "3eccc5dac8056590432db6a35d52b9896876a3d5cbdea53b72400bc9c2099fe801",
};

/** Sender for transactions the scenarios submit at run time. */
export const RUNTIME_SENDER: DevnetAccount = {
  address: "ST3AM1A56AK2C1XAFJ4115ZSV26EB49BVQ10MGCS0",
  privateKey: "7036b29cb5e235e5fd9b09ae3e8eec4404e44906814d5d01cbca968a60ed4bfb01",
};

interface ApiStatusResponse {
  status?: string;
  chain_tip?: { block_height: number };
}

interface ApiNoncesResponse {
  next_nonce: number;
}

/** `GET /extended/v3/transactions/{tx_id}` fields the scenarios read; mined transactions carry `block`. */
export interface ApiTransaction {
  tx_id: string;
  status: string;
  sender: { address: string };
  block?: { height: number };
}

interface ApiPrincipalTransactionsResponse {
  results: { transaction: ApiTransaction }[];
}

interface ApiContractResponse {
  block: { height: number };
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${DEVNET_API_URL}${path}`);

  if (!response.ok) {
    throw new Error(`GET ${path} failed with ${response.status}: ${await response.text()}`);
  }

  // SAFETY: callers name the stacks-blockchain-api response type of `path`.
  return (await response.json()) as T;
}

/** Polls `check` until it returns a value other than `undefined`. */
export async function waitUntil<T>(
  description: string,
  check: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 120_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = undefined;

  while (Date.now() < deadline) {
    try {
      const result = await check();

      if (result !== undefined) {
        return result;
      }
    } catch (error) {
      lastError = error;
    }

    await sleep(1000);
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`, {
    cause: lastError,
  });
}

/** Chain tip height reported by the API, or `undefined` while it is not ready. */
export async function readChainTip(): Promise<number | undefined> {
  const status = await getJson<ApiStatusResponse>("/extended");

  return status.status === "ready" ? status.chain_tip?.block_height : undefined;
}

export async function chainTip(): Promise<number> {
  return waitUntil("the devnet chain tip", readChainTip);
}

export async function waitForBlock(height: number): Promise<void> {
  await waitUntil(`block ${height}`, async () => {
    const tip = await readChainTip();

    return tip !== undefined && tip >= height ? tip : undefined;
  });
}

export async function contractDeployHeight(contractId: string): Promise<number> {
  const contract = await getJson<ApiContractResponse>(`/extended/v3/smart-contracts/${contractId}`);

  return contract.block.height;
}

/** `GET /extended/v2/blocks/{height}` fields the scenarios compare with indexed blocks. */
export interface ApiBlock {
  height: number;
  hash: string;
  index_block_hash: string;
  burn_block_time: number;
}

export async function getBlock(height: number): Promise<ApiBlock> {
  return getJson<ApiBlock>(`/extended/v2/blocks/${height}`);
}

export async function blockHash(height: number): Promise<string> {
  return (await getBlock(height)).hash;
}

/**
 * Most recent anchored transaction sent by `address`, if any. The address
 * history also lists transfers it received (devnet funds every wallet with
 * sBTC), so filter on the sender.
 */
export async function latestSentTransaction(address: string): Promise<ApiTransaction | undefined> {
  const response = await getJson<ApiPrincipalTransactionsResponse>(
    `/extended/v3/principals/${address}/transactions?limit=50`,
  );

  return response.results
    .map(({ transaction }) => transaction)
    .find((transaction) => transaction.sender.address === address);
}

/** Signs, broadcasts and returns the id of a contract call from `sender`. */
export async function callContract(
  sender: DevnetAccount,
  contractId: string,
  functionName: string,
  functionArgs: ClarityValue[] = [],
): Promise<string> {
  const [contractAddress, contractName] = contractId.split(".");

  const { next_nonce: nonce } = await getJson<ApiNoncesResponse>(
    `/extended/v3/principals/${sender.address}/nonces`,
  );

  const transaction = await makeContractCall({
    contractAddress,
    contractName,
    functionName,
    functionArgs,
    senderKey: sender.privateKey,
    nonce,
    fee: 10_000,
    postConditionMode: PostConditionMode.Allow,
    network: "devnet",
    client: { baseUrl: DEVNET_API_URL },
  });

  const result = await broadcastTransaction({
    transaction,
    network: "devnet",
    client: { baseUrl: DEVNET_API_URL },
  });

  if ("error" in result) {
    throw new Error(
      `Broadcast of ${contractId}::${functionName} failed: ${JSON.stringify(result)}`,
    );
  }

  return result.txid.startsWith("0x") ? result.txid : `0x${result.txid}`;
}

export interface ConfirmedTransaction {
  txId: string;
  status: string;
  blockHeight: number;
}

/** Waits until `txId` is included in an anchored block, successful or not. */
export async function waitForTransaction(txId: string): Promise<ConfirmedTransaction> {
  return waitUntil(`transaction ${txId}`, async () => {
    const response = await fetch(`${DEVNET_API_URL}/extended/v3/transactions/${txId}`);

    if (response.status === 404) {
      return undefined;
    }

    // SAFETY: `/extended/v3/transactions/{tx_id}` returns a transaction object.
    const transaction = (await response.json()) as ApiTransaction;

    // Mempool transactions have no block yet.
    if (transaction.block === undefined) {
      return undefined;
    }

    return {
      txId: transaction.tx_id,
      status: transaction.status,
      blockHeight: transaction.block.height,
    };
  });
}

/** Sends a contract call and waits for it to be mined. */
export async function submitContractCall(
  sender: DevnetAccount,
  contractId: string,
  functionName: string,
  functionArgs: ClarityValue[] = [],
): Promise<ConfirmedTransaction> {
  return waitForTransaction(await callContract(sender, contractId, functionName, functionArgs));
}
