import { Option, Predicate, Schema } from "effect";

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

/**
 * Schema for a caller supplied network choice: a named network or a chain ID.
 */
export const NetworkOptionSchema = Schema.Union([
  Schema.Literals(["mainnet", "testnet"]),
  Schema.Int,
]);

function toResolvedNetwork(network: NetworkName | number): ResolvedNetwork {
  if (network === "testnet") {
    return { chainId: TESTNET_CHAIN_ID, baseUrl: TESTNET_API_BASE_URL };
  }

  if (Predicate.isNumber(network)) {
    return { chainId: network, baseUrl: MAINNET_API_BASE_URL };
  }

  return { chainId: MAINNET_CHAIN_ID, baseUrl: MAINNET_API_BASE_URL };
}

export function resolveNetwork(network?: NetworkOption): ResolvedNetwork {
  const decoded = Schema.decodeUnknownOption(NetworkOptionSchema)(network ?? "mainnet");

  if (Option.isNone(decoded)) {
    const label =
      network !== undefined && Predicate.isString(network)
        ? JSON.stringify(network)
        : String(network);

    throw new RangeError(
      `Invalid network: ${label}. Expected "mainnet", "testnet", or a chain ID number.`,
    );
  }

  return toResolvedNetwork(decoded.value);
}
