export const MAINNET_CHAIN_ID = 1;
export const TESTNET_CHAIN_ID = 2_147_483_648;

export const MAINNET_API_BASE_URL = "https://api.hiro.so";
export const TESTNET_API_BASE_URL = "https://api.testnet.hiro.so";

export type NetworkName = "mainnet" | "testnet";

/**
 * Which chain to index.
 *
 * - `"mainnet"` (default): chain ID 1, Hiro mainnet API.
 * - `"testnet"`: chain ID 2147483648, Hiro testnet API.
 * - `number`: custom chain ID, Hiro mainnet API unless `api.baseUrl` overrides it.
 *
 * `network` picks the chain; `api` picks how to reach it (`baseUrl`, `apiKey`).
 */
export type NetworkOption = NetworkName | number;

export interface ResolvedNetwork {
  chainId: number;
  baseUrl: string;
}

function assertValidChainId(chainId: number): void {
  if (!Number.isSafeInteger(chainId)) {
    throw new RangeError(`Invalid chainId: ${chainId}. Expected a safe integer.`);
  }
}

export function resolveNetwork(network?: NetworkOption): ResolvedNetwork {
  if (network === undefined || network === "mainnet") {
    return { chainId: MAINNET_CHAIN_ID, baseUrl: MAINNET_API_BASE_URL };
  }

  if (network === "testnet") {
    return { chainId: TESTNET_CHAIN_ID, baseUrl: TESTNET_API_BASE_URL };
  }

  if (typeof network === "number") {
    assertValidChainId(network);
    return { chainId: network, baseUrl: MAINNET_API_BASE_URL };
  }

  throw new RangeError(
    `Invalid network: ${JSON.stringify(network)}. Expected "mainnet", "testnet", or a chain ID number.`,
  );
}
