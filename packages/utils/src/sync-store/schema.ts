import { pgTable, primaryKey } from "drizzle-orm/pg-core";

export const blocksTable = pgTable(
  "blocks",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    // Height of the block.
    height: table.bigint({ mode: "bigint" }).notNull(),
    // Hash representing the block
    hash: table.varchar({ length: 66 }).notNull(),
    // Unix timestamp (in seconds) indicating when this block was mined.
    blockTime: table.bigint({ mode: "bigint" }).notNull(),
    // The tenure height (AKA coinbase height) of this block.
    tenureHeight: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      name: "blocks_pkey",
      columns: [table.chainId, table.height],
    }),
  ],
);
