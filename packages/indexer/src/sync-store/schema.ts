import { pgTable, primaryKey, text, integer, bigint, boolean } from "drizzle-orm/pg-core";

export const blocksTable = pgTable(
  "blocks",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    height: table.bigint({ mode: "bigint" }).notNull(),
    hash: table.varchar({ length: 66 }).notNull(),
    blockTime: table.bigint({ mode: "bigint" }).notNull(),
    tenureHeight: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      name: "blocks_pkey",
      columns: [table.chainId, table.height],
    }),
  ],
);

export const transactionsTable = pgTable(
  "transactions",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    txId: text("tx_id").notNull(),
    blockHeight: table.bigint({ mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txIndex: integer("tx_index").notNull(),
    txType: text("tx_type").notNull(),
    senderAddress: text("sender_address").notNull(),
    feeRate: bigint("fee_rate", { mode: "bigint" }).notNull(),
    nonce: bigint("nonce", { mode: "bigint" }).notNull(),
    txStatus: text("tx_status").notNull(),
    canonical: boolean("canonical").notNull().default(true),
  }),
  (table) => [
    primaryKey({
      name: "transactions_pkey",
      columns: [table.chainId, table.txId],
    }),
  ],
);

export const syncProgressTable = pgTable(
  "sync_progress",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    contractId: text("contract_id").notNull(),
    cursor: text("cursor").notNull(),
    lastBlockHeight: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      name: "sync_progress_pkey",
      columns: [table.chainId, table.contractId],
    }),
  ],
);
