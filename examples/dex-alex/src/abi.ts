import type { ClarityAbi } from "stacksindex";

export const sip010Abi = {
  functions: [
    {
      name: "get-decimals",
      access: "read_only",
      args: [],
      outputs: {
        type: {
          response: {
            ok: "uint128",
            error: "uint128",
          },
        },
      },
    },
    {
      name: "get-symbol",
      access: "read_only",
      args: [],
      outputs: {
        type: {
          response: {
            ok: { "string-ascii": { length: 32 } },
            error: "uint128",
          },
        },
      },
    },
  ],
  variables: [],
  maps: [],
  fungible_tokens: [],
  non_fungible_tokens: [],
} as const satisfies ClarityAbi;

export const fixedWeightPoolAbi = {
  functions: [
    {
      name: "get-pool-count",
      access: "read_only",
      args: [],
      outputs: {
        type: {
          response: {
            ok: "uint128",
            error: "uint128",
          },
        },
      },
    },
    {
      name: "get-pool-contracts",
      access: "read_only",
      args: [{ name: "pool-id", type: "uint128" }],
      outputs: {
        type: {
          response: {
            ok: {
              tuple: [
                { name: "token-x", type: "principal" },
                { name: "token-y", type: "principal" },
              ],
            },
            error: "uint128",
          },
        },
      },
    },
  ],
  variables: [],
  maps: [],
  fungible_tokens: [],
  non_fungible_tokens: [],
} as const satisfies ClarityAbi;
