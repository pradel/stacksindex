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

/**
 * Nakamoto produces a Stacks block about every 8 seconds, so 450 blocks is
 * roughly one hour. The interval counts blocks, not time: it drifts with the
 * block rate.
 */
export const POOL_SNAPSHOT_INTERVAL = 450;

/** A recent Nakamoto height: about a month of hourly snapshots as of late 2026. */
export const POOL_SNAPSHOT_START_BLOCK = 9_000_000;

export const indexer = defineIndexer({
  relations,
  contracts: {
    pool: { id: POOL_CONTRACT, print: PoolLog, onInvalid: "skip" },
  },
  blocks: {
    poolSnapshots: { interval: POOL_SNAPSHOT_INTERVAL, startBlock: POOL_SNAPSHOT_START_BLOCK },
  },
});
