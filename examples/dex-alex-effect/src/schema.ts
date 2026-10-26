import { defineRelations } from "drizzle-orm";
import { pgTable, primaryKey } from "drizzle-orm/pg-core";

export const tokenTable = pgTable(
  "token",
  (table) => ({
    address: table.text("address").notNull(),
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    symbol: table.text("symbol").notNull(),
    decimals: table.integer("decimals").notNull(),
  }),
  (table) => [
    primaryKey({
      columns: [table.address, table.chainId],
    }),
  ],
);

export type Token = typeof tokenTable.$inferSelect;

export const poolTable = pgTable(
  "pool",
  (table) => ({
    address: table.text("address").notNull(),
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    tokenX: table.text("token_x"),
    tokenY: table.text("token_y"),
    balanceX: table.bigint({ mode: "bigint" }).notNull(),
    balanceY: table.bigint({ mode: "bigint" }).notNull(),
    totalSupply: table.bigint({ mode: "bigint" }).notNull(),
    feeRateX: table.bigint({ mode: "bigint" }).notNull(),
    feeRateY: table.bigint({ mode: "bigint" }).notNull(),
    feeToAddress: table.text("fee_to_address").notNull(),
    oracleEnabled: table.boolean("oracle_enabled").notNull(),
    createdAt: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      columns: [table.address, table.chainId],
    }),
  ],
);

export const swapTable = pgTable(
  "swap",
  (table) => ({
    txId: table.text("tx_id").notNull(),
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    eventIndex: table.integer("event_index").notNull(),
    poolAddress: table.text("pool_address").notNull(),
    action: table.text("action").notNull(),
    amountIn: table.bigint({ mode: "bigint" }).notNull(),
    amountOut: table.bigint({ mode: "bigint" }).notNull(),
    blockHeight: table.bigint({ mode: "bigint" }).notNull(),
    blockTime: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      columns: [table.txId, table.chainId, table.eventIndex],
    }),
  ],
);

/** Pool balances read every `poolSnapshots` interval, one row per pool and block. */
export const poolSnapshotTable = pgTable(
  "pool_snapshot",
  (table) => ({
    poolAddress: table.text("pool_address").notNull(),
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    blockHeight: table.bigint({ mode: "bigint" }).notNull(),
    blockTime: table.bigint({ mode: "bigint" }).notNull(),
    balanceX: table.bigint({ mode: "bigint" }).notNull(),
    balanceY: table.bigint({ mode: "bigint" }).notNull(),
    totalSupply: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      columns: [table.poolAddress, table.chainId, table.blockHeight],
    }),
  ],
);

/**
 * Passed to `defineIndexer`, types `indexer.Db`'s `db.query.<table>`.
 * Rows are keyed by address and chain, so every join matches both.
 */
export const relations = defineRelations(
  { token: tokenTable, pool: poolTable, swap: swapTable, poolSnapshot: poolSnapshotTable },
  (r) => ({
    pool: {
      xToken: r.one.token({
        from: [r.pool.tokenX, r.pool.chainId],
        to: [r.token.address, r.token.chainId],
      }),
      yToken: r.one.token({
        from: [r.pool.tokenY, r.pool.chainId],
        to: [r.token.address, r.token.chainId],
      }),
      swaps: r.many.swap({
        from: [r.pool.address, r.pool.chainId],
        to: [r.swap.poolAddress, r.swap.chainId],
      }),
      snapshots: r.many.poolSnapshot({
        from: [r.pool.address, r.pool.chainId],
        to: [r.poolSnapshot.poolAddress, r.poolSnapshot.chainId],
      }),
    },
    swap: {
      pool: r.one.pool({
        from: [r.swap.poolAddress, r.swap.chainId],
        to: [r.pool.address, r.pool.chainId],
      }),
    },
    poolSnapshot: {
      pool: r.one.pool({
        from: [r.poolSnapshot.poolAddress, r.poolSnapshot.chainId],
        to: [r.pool.address, r.pool.chainId],
      }),
    },
  }),
);
