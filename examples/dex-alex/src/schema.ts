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
