import { Effect, References, Schema } from "effect";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { StacksClient } from "../datasources/api/index.ts";
import { InvalidCursorError } from "../lib/errors.ts";
import { createFakeChain, type FakeChain, type FakeTransaction } from "../test-utils/fake-chain.ts";
import { buildLogsCursor, findBackfillCursor, parseLogsCursor } from "./cursor.ts";

const CONTRACT_ID = "SP1.dlmm-core";

const BASE_HEIGHT = 100;

/** A transaction emitting `count` logs of the contract. */
const logsTx = (txId: string, count: number): FakeTransaction => ({
  txId,
  events: Array.from({ length: count }, (_, eventIndex) => ({
    contractId: CONTRACT_ID,
    eventIndex,
  })),
});

const findCursor = (fromBlockHeight: number) =>
  Effect.runPromise(
    findBackfillCursor(CONTRACT_ID, fromBlockHeight).pipe(
      Effect.provide(StacksClient.layer({ baseUrl: "https://api.example.com" })),
      Effect.provideService(References.MinimumLogLevel, "None"),
    ),
  );

const decodeLogsPage = Schema.decodeUnknownSync(
  Schema.Struct({
    results: Schema.Array(Schema.Struct({ tx_id: Schema.String, event_index: Schema.Number })),
  }),
);

/** `tx|eventIndex` of the events on the logs page at `cursor`, oldest first. */
const pageAt = async (chain: FakeChain, cursor: string | null) => {
  const response = await chain.fetch(
    `https://api.example.com/extended/v2/smart-contracts/${CONTRACT_ID}/logs?limit=100&cursor=${String(cursor)}`,
  );

  const { results } = decodeLogsPage(await response.json());

  return results.map((event) => `${event.tx_id}|${event.event_index}`).toReversed();
};

describe("backfill cursor", () => {
  // oxlint-disable-next-line init-declarations
  let chain: FakeChain;

  beforeAll(() => {
    // The HTTP client may keep the first `fetch` it sees; delegate to the current chain.
    vi.stubGlobal("fetch", (input: string | URL | Request) => chain.fetch(input));
  });

  beforeEach(() => {
    chain = createFakeChain({ baseHeight: BASE_HEIGHT });
  });

  test("starts one page above the newest event below the start block, in one request", async () => {
    chain.mine([logsTx("tx-101", 150)]);
    chain.mine([logsTx("tx-102", 120)]);
    chain.mine([logsTx("tx-103", 120)]);

    const cursor = await findCursor(102);

    expect(chain.requests).toStrictEqual([
      `/extended/v2/smart-contracts/${CONTRACT_ID}/logs?limit=100&cursor=101:2147483647:32767:2147483647`,
    ]);

    // The page at the cursor starts with the first event of block 102.
    const page = await pageAt(chain, cursor);

    expect(page[0]).toBe("tx-102|0");
    expect(page).toHaveLength(100);
  });

  test("returns null when less than a page of events lies above the start block", async () => {
    chain.mine([logsTx("tx-101", 150)]);
    chain.mine([logsTx("tx-102", 20)]);

    await expect(findCursor(102)).resolves.toBeNull();
  });

  test("finds the oldest events when none lie below the start block", async () => {
    chain.mine();
    // The first block with events holds more than one page of them.
    chain.mine([logsTx("tx-102", 250)]);
    chain.mine([logsTx("tx-103", 10)]);

    const page = await pageAt(chain, await findCursor(1));

    expect(page[0]).toBe("tx-102|0");
  });

  test("returns null for a contract without events", async () => {
    chain.mine();

    await expect(findCursor(1)).resolves.toBeNull();
  });

  test("fails on an API that only accepts cursors of existing events", async () => {
    chain = createFakeChain({ baseHeight: BASE_HEIGHT, exactLogCursors: true });
    chain.mine([logsTx("tx-101", 10)]);

    await expect(findCursor(1)).rejects.toBeInstanceOf(InvalidCursorError);
  });
});

describe("cursor utilities", () => {
  test("builds and parses logs cursor", async () => {
    const cursor = buildLogsCursor({
      blockHeight: 123,
      microblockSequence: 0,
      txIndex: 4,
      eventIndex: 2,
    });

    expect(cursor).toBe("123:0:4:2");

    const parsed = await Effect.runPromise(parseLogsCursor("123:0:4:2"));

    expect(parsed).toStrictEqual({
      blockHeight: 123,
      microblockSequence: 0,
      txIndex: 4,
      eventIndex: 2,
    });
  });
});
