import { defineIndexer } from "stacksindex";
import { z } from "zod";

import { relations } from "./schema.ts";

export const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

const poolCreatedLogSchema = z
  .object({
    object: z.literal("pool"),
    action: z.literal("created"),
    data: z.object({
      "pool-token": z.string(),
      "fee-rate-x": z.bigint().optional().default(0n),
      "fee-rate-y": z.bigint().optional().default(0n),
      "fee-to-address": z.string().optional().default(""),
      "oracle-enabled": z.boolean().optional().default(false),
    }),
  })
  .transform((val) => ({
    action: val.action,
    poolToken: val.data["pool-token"],
    feeRateX: val.data["fee-rate-x"],
    feeRateY: val.data["fee-rate-y"],
    feeToAddress: val.data["fee-to-address"],
    oracleEnabled: val.data["oracle-enabled"],
  }));

const poolBalanceLogSchema = z
  .object({
    object: z.literal("pool"),
    action: z.enum([
      "swap-x-for-y",
      "swap-y-for-x",
      "liquidity-added",
      "liquidity-removed",
      "add-to-position",
      "reduce-position",
      "set-fee-to-address",
      "set-fee-rate-x",
      "set-fee-rate-y",
      "set-oracle-enabled",
      "set-oracle-average",
    ]),
    data: z.object({
      "pool-token": z.string(),
      "balance-x": z.bigint(),
      "balance-y": z.bigint(),
      "total-supply": z.bigint(),
    }),
  })
  .transform((val) => ({
    action: val.action,
    poolToken: val.data["pool-token"],
    balanceX: val.data["balance-x"],
    balanceY: val.data["balance-y"],
    totalSupply: val.data["total-supply"],
  }));

/** The pool prints the indexer handles; every other print is skipped (`onInvalid: "skip"`). */
export const poolLogSchema = z.union([poolCreatedLogSchema, poolBalanceLogSchema]);

export const indexer = defineIndexer({
  relations,
  contracts: {
    pool: { id: POOL_CONTRACT, print: poolLogSchema, onInvalid: "skip" },
  },
});
