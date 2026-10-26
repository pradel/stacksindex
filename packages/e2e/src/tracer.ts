import type { BlockEvent, PrintEvent } from "stacksindex";
import type { ClarityJsonValue } from "stacksindex/clarity";

export interface RecordedTraceEvent {
  contractId: string;
  blockHeight: number;
  txIndex: number;
  eventIndex: number;
  txId: string;
  topic: string;
  blockTime: number;
  senderAddress: string;
  valueHex: string;
  valueRepr: string;
  decoded: ClarityJsonValue;
  recordedAt: number;
}

/** A block source run, as its handler received it. */
export interface RecordedBlockEvent {
  name: string;
  blockHeight: number;
  blockTime: number;
  hash: string;
  indexBlockHash: string;
}

/** One handler call, in delivery order: a print of a contract or a block source run. */
export type TraceEntry =
  | { type: "print"; blockHeight: number; contractId: string }
  | { type: "block"; blockHeight: number; name: string };

export interface TraceCollector {
  record: (event: PrintEvent) => void;
  recordBlock: (event: BlockEvent) => void;
  getBlockEvents: () => RecordedBlockEvent[];
  /** Every recorded print and block source run, in delivery order. */
  getSequence: () => TraceEntry[];
  getEvents: () => RecordedTraceEvent[];
  getEventsForContract: (contractId: string) => RecordedTraceEvent[];
  assertChronologicalOrder: () => void;
  exportCsv: () => string;
  toSnapshot: () => {
    contractId: string;
    blockHeight: number;
    txIndex: number;
    eventIndex: number;
    topic: string;
    decoded: ClarityJsonValue;
  }[];
  clear: () => void;
}

export function createTraceCollector(): TraceCollector {
  const events: RecordedTraceEvent[] = [];
  const blockEvents: RecordedBlockEvent[] = [];
  const sequence: TraceEntry[] = [];

  return {
    record(event: PrintEvent) {
      sequence.push({
        type: "print",
        blockHeight: event.block.height,
        contractId: event.contractId,
      });
      events.push({
        contractId: event.contractId,
        blockHeight: event.block.height,
        txIndex: event.tx.index,
        eventIndex: event.eventIndex,
        txId: event.txId,
        topic: event.raw.topic,
        blockTime: event.block.time,
        senderAddress: event.tx.sender,
        valueHex: event.raw.hex,
        valueRepr: event.raw.repr,
        decoded: event.data,
        recordedAt: Date.now(),
      });
    },

    recordBlock(event: BlockEvent) {
      sequence.push({ type: "block", blockHeight: event.block.height, name: event.name });
      blockEvents.push({
        name: event.name,
        blockHeight: event.block.height,
        blockTime: event.block.time,
        hash: event.block.hash,
        indexBlockHash: event.block.indexBlockHash,
      });
    },

    getBlockEvents() {
      return [...blockEvents];
    },

    getSequence() {
      return [...sequence];
    },

    getEvents() {
      return [...events];
    },

    getEventsForContract(contractId: string) {
      return events.filter((eventItem) => eventItem.contractId === contractId);
    },

    assertChronologicalOrder() {
      for (let index = 1; index < events.length; index += 1) {
        const prev = events[index - 1];
        const curr = events[index];

        if (curr.blockHeight < prev.blockHeight) {
          throw new Error(
            `Chronological ordering violation: event at index ${index} has blockHeight ${curr.blockHeight} < previous blockHeight ${prev.blockHeight}`,
          );
        }

        if (curr.blockHeight === prev.blockHeight) {
          if (curr.txIndex < prev.txIndex) {
            throw new Error(
              `Chronological ordering violation: event at index ${index} in block ${curr.blockHeight} has txIndex ${curr.txIndex} < previous txIndex ${prev.txIndex}`,
            );
          }

          if (curr.txIndex === prev.txIndex && curr.eventIndex < prev.eventIndex) {
            throw new Error(
              `Chronological ordering violation: event at index ${index} in block ${curr.blockHeight}, tx ${curr.txIndex} has eventIndex ${curr.eventIndex} < previous eventIndex ${prev.eventIndex}`,
            );
          }
        }
      }
    },

    exportCsv() {
      const headers = [
        "contract_id",
        "block_height",
        "tx_index",
        "event_index",
        "tx_id",
        "topic",
        "value_repr",
      ];

      const rows = events.map((eventItem) =>
        [
          eventItem.contractId,
          eventItem.blockHeight,
          eventItem.txIndex,
          eventItem.eventIndex,
          eventItem.txId,
          `"${eventItem.topic.replaceAll('"', '""')}"`,
          `"${eventItem.valueRepr.replaceAll('"', '""')}"`,
        ].join(","),
      );

      return [headers.join(","), ...rows].join("\n");
    },

    toSnapshot() {
      return events.map((eventItem) => ({
        contractId: eventItem.contractId,
        blockHeight: eventItem.blockHeight,
        txIndex: eventItem.txIndex,
        eventIndex: eventItem.eventIndex,
        topic: eventItem.topic,
        decoded: eventItem.decoded,
      }));
    },

    clear() {
      events.length = 0;
      blockEvents.length = 0;
      sequence.length = 0;
    },
  };
}
