import type { PrintEvent } from "stacksindex";
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

export interface TraceCollector {
  record: (event: PrintEvent) => void;
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

  return {
    record(event: PrintEvent) {
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
    },
  };
}
