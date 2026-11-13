import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema that holds every table owned by the indexer, so user tables
 * in `public` can share the database without name collisions.
 */
export const STACKSINDEX_SCHEMA = "stacksindex";

// Not exported, so drizzle-kit emits no `CREATE SCHEMA`: the migrator creates
// It first because it also holds the internal migrations table.
const stacksindexSchema = pgSchema(STACKSINDEX_SCHEMA);

export const blocksTable = stacksindexSchema.table(
  "blocks",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    height: table.bigint({ mode: "bigint" }).notNull(),
    hash: table.varchar({ length: 66 }).notNull(),
    /** Identifies the block for `call-read` `tip`, which accepts no other block id. */
    indexBlockHash: table.varchar({ length: 66 }).notNull(),
    blockTime: table.bigint({ mode: "bigint" }).notNull(),
    tenureHeight: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      name: "blocks_pkey",
      columns: [table.chainId, table.height],
    }),
    index("blocks_chain_id_hash_idx").on(table.chainId, table.hash),
  ],
);

export const transactionsTable = stacksindexSchema.table(
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
  }),
  (table) => [
    primaryKey({
      name: "transactions_pkey",
      columns: [table.chainId, table.txId],
    }),
  ],
);

export const syncProgressTable = stacksindexSchema.table(
  "sync_progress",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    contractId: text("contract_id").notNull(),
    cursor: text("cursor"),
    /** Every event of the contract at or below this height is stored. */
    syncedBlockHeight: table.bigint({ mode: "bigint" }).notNull(),
    isComplete: boolean("is_complete").notNull().default(false),
  }),
  (table) => [
    primaryKey({
      name: "sync_progress_pkey",
      columns: [table.chainId, table.contractId],
    }),
  ],
);

export const eventsTable = stacksindexSchema.table(
  "events",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    contractId: text("contract_id").notNull(),
    txId: text("tx_id").notNull(),
    eventIndex: integer("event_index").notNull(),
    eventType: text("event_type").notNull(),
    topic: text("topic").notNull(),
    valueHex: text("value_hex").notNull(),
    valueRepr: text("value_repr").notNull(),
    blockHeight: table.bigint({ mode: "bigint" }).notNull(),
  }),
  (table) => [
    primaryKey({
      name: "events_pkey",
      columns: [table.chainId, table.txId, table.eventIndex],
    }),
    index("events_chain_id_block_height_idx").on(table.chainId, table.blockHeight),
  ],
);

export const checkpointsTable = stacksindexSchema.table(
  "checkpoints",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    blockHeight: table.bigint({ mode: "bigint" }).notNull(),
    blockTime: table.bigint({ mode: "bigint" }).notNull(),
    finalizedBlockHeight: table.bigint({ mode: "bigint" }).notNull().default(0n),
    finalizedBlockTime: table.bigint({ mode: "bigint" }).notNull().default(0n),
  }),
  (table) => [
    primaryKey({
      name: "checkpoints_pkey",
      columns: [table.chainId],
    }),
  ],
);

/**
 * The chain tip read at the start of the latest run. Nothing above it has been
 * indexed, and its hash proves at the next run that every stored block at or
 * below it is still canonical.
 */
export const syncAnchorsTable = stacksindexSchema.table(
  "sync_anchors",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    blockHeight: table.bigint({ mode: "bigint" }).notNull(),
    blockHash: table.varchar({ length: 66 }).notNull(),
  }),
  (table) => [
    primaryKey({
      name: "sync_anchors_pkey",
      columns: [table.chainId],
    }),
  ],
);

/** A contract as recorded in `meta.contracts`: what decides which events are indexed. */
export interface RecordedContract {
  readonly id: string;
  readonly startBlock: number | null;
  readonly endBlock: number | "latest" | null;
}

/**
 * What the indexer using the database was defined with, per chain. Compared
 * with the definition at the start of every `run` and `live`.
 */
export const metaTable = stacksindexSchema.table(
  "meta",
  (table) => ({
    chainId: table.bigint({ mode: "bigint" }).notNull(),
    /** Defined contracts, ordered by id. */
    contracts: jsonb("contracts").$type<RecordedContract[]>().notNull(),
  }),
  (table) => [
    primaryKey({
      name: "meta_pkey",
      columns: [table.chainId],
    }),
  ],
);

/**
 * One row: the format of the data in this schema. A release that changes what
 * stored data means raises it, so a database written by another format fails
 * to open instead of being misread.
 */
export const versionTable = stacksindexSchema.table("version", (table) => ({
  dataVersion: table.integer().primaryKey(),
}));
