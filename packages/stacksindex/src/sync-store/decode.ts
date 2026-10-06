import { Schema } from "effect";

import type { HandlerEvent } from "../lib/types.ts";

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
  txIndex: Schema.Int,
  senderAddress: Schema.String,
});

export type StoredEvent = typeof StoredEventSchema.Type;

export const decodeStoredEvents = Schema.decodeUnknownEffect(Schema.Array(StoredEventSchema));

export const storedEventToHandlerEvent = (event: StoredEvent): HandlerEvent => ({
  event_index: event.eventIndex,
  event_type: event.eventType,
  tx_id: event.txId,
  contract_log: {
    contract_id: event.contractId,
    topic: event.topic,
    value: {
      hex: event.valueHex,
      repr: event.valueRepr,
    },
  },
  block_height: Number(event.blockHeight),
  block_time: Number(event.blockTime),
  tx_index: event.txIndex,
  sender_address: event.senderAddress,
});
