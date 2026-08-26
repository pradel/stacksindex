import type { ClarityValue } from "@stacks/transactions";
import type { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { StacksApiError } from "../datasources/api/errors.ts";
import type { CallReadResponse, SmartContractLogEvent } from "../datasources/api/index.ts";

/**
 * Network preset or a custom endpoint.
 * - `"mainnet"` / `"testnet"` resolve to the hosted Hiro API endpoints.
 * - A custom `{ url }` targets any Stacks API compatible endpoint.
 */
export type NetworkConfig =
  | "mainnet"
  | "testnet"
  | {
      url: string;
      /** Chain id used to namespace sync store data. Defaults to `1`. */
      chainId?: number;
    };

export interface ResolvedNetwork {
  baseUrl: string;
  chainId: number;
}

export const NETWORK_PRESETS: Record<"mainnet" | "testnet", ResolvedNetwork> = {
  mainnet: { baseUrl: "https://api.hiro.so", chainId: 1 },
  testnet: { baseUrl: "https://api.testnet.hiro.so", chainId: 2_147_483_648 },
};

export function resolveNetwork(network: NetworkConfig = "mainnet"): ResolvedNetwork {
  if (typeof network === "string") {
    return NETWORK_PRESETS[network];
  }
  return { baseUrl: network.url, chainId: network.chainId ?? 1 };
}

export interface FilterBounds {
  startBlock?: number;
  endBlock?: number;
}

export interface Filter extends FilterBounds {
  contractId: string;
  handler: EventHandler;
}

export type HandlerEvent = SmartContractLogEvent & {
  block_height: number;
  block_time: number;
  tx_index: number;
  sender_address: string;
  /**
   * Decoded Clarity value of the contract log (`event.contract_log.value.hex`).
   * `undefined` when the value could not be decoded; use the raw hex in that case.
   */
  decoded: ClarityValue | undefined;
};

export interface IndexingClient {
  callReadOnly(
    contractId: string,
    functionName: string,
    /** `tip` is overridden by the runtime with the block being processed. */
    options?: { args?: string[]; sender?: string; tip?: number },
  ): Promise<Result<CallReadResponse, StacksApiError>>;
}

export interface HandlerContext {
  db: NodePgDatabase | PgliteDatabase;
  client: IndexingClient;
}

export type EventHandler = (event: HandlerEvent, context: HandlerContext) => Promise<void>;

export type Handlers = Record<string, EventHandler | undefined>;
