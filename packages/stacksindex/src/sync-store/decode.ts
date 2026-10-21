import { Schema } from "effect";

import type { PrintEvent } from "../lib/types.ts";

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
