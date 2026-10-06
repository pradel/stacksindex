import { describe, expect, test } from "vite-plus/test";

import type { StoredEvent } from "../sync-store/decode.ts";
import { chunkEventsByBlock, MAX_BATCH_EVENTS } from "./batches.ts";

const storedEvent = (blockHeight: number, eventIndex: number): StoredEvent => ({
  eventIndex,
  eventType: "smart_contract_log",
  txId: `tx-${blockHeight}`,
  contractId: "SP123.token",
  topic: "print",
  valueHex: "0x01",
  valueRepr: "(ok true)",
  blockHeight: BigInt(blockHeight),
  blockTime: 1000n,
  txIndex: 0,
  senderAddress: "SP sender",
});

const events = (blockHeight: number, count: number): StoredEvent[] =>
  Array.from({ length: count }, (_, eventIndex) => storedEvent(blockHeight, eventIndex));

const blockHeights = (batch: StoredEvent[]) => batch.map((event) => Number(event.blockHeight));

describe("chunk events by block", () => {
  test("returns no batches for no events", () => {
    expect(chunkEventsByBlock([], 2)).toStrictEqual([]);
  });

  test("closes a batch at a block boundary once it reaches the batch size", () => {
    const batches = chunkEventsByBlock([...events(100, 2), ...events(200, 1)], 2);

    expect(batches.map(blockHeights)).toStrictEqual([[100, 100], [200]]);
  });

  test("keeps a block that is larger than the batch size in a single batch", () => {
    const batches = chunkEventsByBlock(events(100, 5), 2);

    expect(batches.map(blockHeights)).toStrictEqual([[100, 100, 100, 100, 100]]);
  });

  test("does not split a block across batches", () => {
    const batches = chunkEventsByBlock(
      [...events(100, 3), ...events(200, 3), ...events(300, 1)],
      4,
    );

    expect(batches.map(blockHeights)).toStrictEqual([[100, 100, 100, 200, 200, 200], [300]]);
  });

  test("uses the default maximum batch size", () => {
    const batches = chunkEventsByBlock([...events(100, MAX_BATCH_EVENTS), ...events(200, 1)]);

    expect(batches.map((batch) => batch.length)).toStrictEqual([MAX_BATCH_EVENTS, 1]);
  });
});
