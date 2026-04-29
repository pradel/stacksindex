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
    baseToken: table.text("base_token").notNull(),
    quoteToken: table.text("quote_token").notNull(),
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
    amountIn: table.bigint({ mode: "bigint" }).notNull(),
    amountOut: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      columns: [table.txId, table.chainId],
    }),
  ],
);
