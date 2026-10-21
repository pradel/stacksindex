import { Schema } from "effect";
import { defineIndexer } from "stacksindex/effect";

import { relations } from "./schema.ts";

export const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

const PoolCreatedLog = Schema.Struct({
  object: Schema.Literal("pool"),
  action: Schema.Literal("created"),
  data: Schema.Struct({
    "pool-token": Schema.String,
    "fee-rate-x": Schema.optional(Schema.BigInt),
    "fee-rate-y": Schema.optional(Schema.BigInt),
    "fee-to-address": Schema.optional(Schema.String),
    "oracle-enabled": Schema.optional(Schema.Boolean),
  }),
});

const PoolBalanceLog = Schema.Struct({
  object: Schema.Literal("pool"),
  action: Schema.Literals([
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
  data: Schema.Struct({
    "pool-token": Schema.String,
    "balance-x": Schema.BigInt,
    "balance-y": Schema.BigInt,
    "total-supply": Schema.BigInt,
  }),
});

/** The pool prints the indexer handles; every other print is skipped (`onInvalid: "skip"`). */
export const PoolLog = Schema.Union([PoolCreatedLog, PoolBalanceLog]);

export const indexer = defineIndexer({
  relations,
  contracts: {
    pool: { id: POOL_CONTRACT, print: PoolLog, onInvalid: "skip" },
  },
});
