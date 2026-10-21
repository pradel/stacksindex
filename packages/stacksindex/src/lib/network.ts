import { Predicate, Schema } from "effect";

export const MAINNET_CHAIN_ID = 1;

export const TESTNET_CHAIN_ID = 2_147_483_648;

export const MAINNET_API_URL = "https://api.hiro.so";

export const TESTNET_API_URL = "https://api.testnet.hiro.so";

/**
 * Which chain to index.
 *
 * - `"mainnet"` (default): chain ID 1, Hiro mainnet API.
 * - `"testnet"`: chain ID 2147483648, Hiro testnet API.
 * - `{ id, apiUrl }`: any other chain (e.g. a devnet) and the Stacks API serving it.
 *
 * `api.url` overrides the chain's API URL, e.g. to use your own node.
 */
export type ChainOption = "mainnet" | "testnet" | { readonly id: number; readonly apiUrl: string };

export interface ResolvedChain {
  readonly chainId: number;
  readonly apiUrl: string;
}

export const ChainOptionSchema = Schema.Union([
  Schema.Literals(["mainnet", "testnet"]),
  Schema.Struct({ id: Schema.Natural, apiUrl: Schema.String }),
]);

export function resolveChain(chain: typeof ChainOptionSchema.Type | undefined): ResolvedChain {
  if (chain === undefined || chain === "mainnet") {
    return { chainId: MAINNET_CHAIN_ID, apiUrl: MAINNET_API_URL };
  }

  if (chain === "testnet") {
    return { chainId: TESTNET_CHAIN_ID, apiUrl: TESTNET_API_URL };
  }

  // Unreachable from TypeScript; plain JavaScript can pass any string.
  if (Predicate.isString(chain)) {
    throw new RangeError(
      `Invalid chain: ${JSON.stringify(chain)}. Expected "mainnet", "testnet", or { id, apiUrl }.`,
    );
  }

  return { chainId: chain.id, apiUrl: chain.apiUrl };
}
