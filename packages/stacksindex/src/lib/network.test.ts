import { describe, expect, test } from "vite-plus/test";

import {
  MAINNET_API_URL,
  MAINNET_CHAIN_ID,
  resolveChain,
  TESTNET_API_URL,
  TESTNET_CHAIN_ID,
} from "./network.ts";

describe("chain", () => {
  test("defaults to mainnet when omitted", () => {
    expect(resolveChain(undefined)).toStrictEqual({
      chainId: MAINNET_CHAIN_ID,
      apiUrl: MAINNET_API_URL,
    });
  });

  test('resolves "mainnet"', () => {
    expect(resolveChain("mainnet")).toStrictEqual({
      chainId: MAINNET_CHAIN_ID,
      apiUrl: MAINNET_API_URL,
    });
  });

  test('resolves "testnet" with testnet API', () => {
    expect(resolveChain("testnet")).toStrictEqual({
      chainId: TESTNET_CHAIN_ID,
      apiUrl: TESTNET_API_URL,
    });
  });

  test("resolves a custom chain with its API URL", () => {
    expect(resolveChain({ id: 1234, apiUrl: "http://localhost:3999" })).toStrictEqual({
      chainId: 1234,
      apiUrl: "http://localhost:3999",
    });
  });
});
