import { describe, expect, test } from "vite-plus/test";

import {
  MAINNET_API_BASE_URL,
  MAINNET_CHAIN_ID,
  TESTNET_API_BASE_URL,
  TESTNET_CHAIN_ID,
  resolveNetwork,
  type NetworkOption,
} from "./network.ts";

describe("network", () => {
  test("defaults to mainnet when omitted", () => {
    expect(resolveNetwork()).toStrictEqual({
      chainId: MAINNET_CHAIN_ID,
      baseUrl: MAINNET_API_BASE_URL,
    });
    expect(resolveNetwork(undefined)).toStrictEqual({
      chainId: MAINNET_CHAIN_ID,
      baseUrl: MAINNET_API_BASE_URL,
    });
  });

  test('resolves "mainnet"', () => {
    expect(resolveNetwork("mainnet")).toStrictEqual({
      chainId: MAINNET_CHAIN_ID,
      baseUrl: MAINNET_API_BASE_URL,
    });
  });

  test('resolves "testnet" with testnet API', () => {
    expect(resolveNetwork("testnet")).toStrictEqual({
      chainId: TESTNET_CHAIN_ID,
      baseUrl: TESTNET_API_BASE_URL,
    });
  });

  test("resolves a custom chain ID number", () => {
    expect(resolveNetwork(1234)).toStrictEqual({ chainId: 1234, baseUrl: MAINNET_API_BASE_URL });
  });

  test("rejects non-integer chain IDs", () => {
    for (const network of [1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => resolveNetwork(network)).toThrow(
        `Invalid network: ${String(network)}. Expected "mainnet", "testnet", or a chain ID number.`,
      );
    }
  });

  test("rejects unknown network names", () => {
    const invalid = `devnet`;
    // SAFETY: "devnet" is intentionally outside NetworkOption to test runtime rejection.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const invalidOption = invalid as NetworkOption;
    expect(() => resolveNetwork(invalidOption)).toThrow(
      'Invalid network: "devnet". Expected "mainnet", "testnet", or a chain ID number.',
    );
  });
});
