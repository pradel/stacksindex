import { Schema } from "effect";

import type { BlockEvent, PrintEvent } from "../lib/types.ts";

/**
 * Runtime shape of an `events` row joined with its transaction and block, as
 * returned by `syncStore.getEvents`.
 */
export const StoredEventSchema = Schema.Struct({
  eventIndex: Schema.Int,
  eventType: Schema.Literal("smart_contract_log"),
  txId: Schema.String,
  contractId: Schema.String,
  topic: Schema.String,
  valueHex: Schema.String,
  valueRepr: Schema.String,
  blockHeight: Schema.BigInt,
  blockTime: Schema.BigInt,
  blockHash: Schema.String,
  indexBlockHash: Schema.String,
  txIndex: Schema.Int,
  senderAddress: Schema.String,
});

export type StoredEvent = typeof StoredEventSchema.Type;

export const decodeStoredEvents = Schema.decodeUnknownEffect(Schema.Array(StoredEventSchema));

/** A stored block that a block source runs at, as returned by `syncStore.getSourceBlocks`. */
export const StoredSourceBlockSchema = Schema.Struct({
  blockHeight: Schema.BigInt,
  blockTime: Schema.BigInt,
  blockHash: Schema.String,
  indexBlockHash: Schema.String,
});

export type StoredSourceBlock = typeof StoredSourceBlockSchema.Type;

export const decodeStoredSourceBlocks = Schema.decodeUnknownEffect(
  Schema.Array(StoredSourceBlockSchema),
);

/** A stored block to run block source `source` at, in indexing order with stored events. */
export interface StoredBlockSourceRow extends StoredSourceBlock {
  readonly eventType: "block";
  /** Definition name of the block source. */
  readonly source: string;
}

/** A row indexed by `Indexing.executeBatch`: a print or a block source run. */
export type IndexRow = StoredEvent | StoredBlockSourceRow;

/** The handler payload of a block source run. */
export const storedBlockToBlockEvent = (row: StoredBlockSourceRow): BlockEvent => ({
  type: "block",
  name: row.source,
  block: {
    height: Number(row.blockHeight),
    time: Number(row.blockTime),
    hash: row.blockHash,
    indexBlockHash: row.indexBlockHash,
  },
});

/** The handler payload for a stored event of contract `contract`, carrying `data`. */
export const storedEventToPrintEvent = <TData>(
  event: StoredEvent,
  contract: string,
  data: TData,
): PrintEvent<TData> => ({
  type: "print",
  contract,
  contractId: event.contractId,
  txId: event.txId,
  eventIndex: event.eventIndex,
  data,
  raw: { hex: event.valueHex, repr: event.valueRepr, topic: event.topic },
  block: {
    height: Number(event.blockHeight),
    time: Number(event.blockTime),
    hash: event.blockHash,
    indexBlockHash: event.indexBlockHash,
  },
  tx: { index: event.txIndex, sender: event.senderAddress },
});
