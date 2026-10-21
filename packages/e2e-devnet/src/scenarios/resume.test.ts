import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Cl } from "@stacks/transactions";
import { sql } from "drizzle-orm";
import { integer, pgTable, text } from "drizzle-orm/pg-core";
import { createTraceCollector } from "indexer-e2e/src/tracer.ts";
import { pglite, type IndexerDb } from "stacksindex";
import { afterAll, describe, expect, test } from "vite-plus/test";

import { chainTip, EVENTS_CONTRACT, RUNTIME_SENDER, submitContractCall } from "../chain.ts";
import { createDevnetIndexer, type DevnetHandler } from "../indexer.ts";

const migrations = path.resolve(import.meta.dirname, "../migrations");

const eventCounts = pgTable("event_counts", {
  contractId: text("contract_id").primaryKey(),
  count: integer().notNull(),
});

/** Counts events with a non-idempotent increment, so any double apply shows. */
const countEvent = (db: IndexerDb) =>
  db
    .insert(eventCounts)
    .values({ contractId: EVENTS_CONTRACT, count: 1 })
    .onConflictDoUpdate({
      target: eventCounts.contractId,
      set: { count: sql`${eventCounts.count} + 1` },
    });

const readCount = async (db: IndexerDb): Promise<number | undefined> => {
  const [row] = await db.select().from(eventCounts);

  return row?.count;
};

describe("resuming on the same database", () => {
  test("indexes only the events added since the previous run", async () => {
    const startBlock = (await chainTip()) + 1;

    const first = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(10),
    ]);

    const trace = createTraceCollector();

    await using indexer = await createDevnetIndexer({
      trace,
      contracts: [{ contractId: EVENTS_CONTRACT, startBlock }],
    });

    const firstRun = await indexer.run();

    expect(firstRun.eventsProcessed).toBe(1);
    expect(trace.getEvents().map((event) => event.txId)).toStrictEqual([first.txId]);

    trace.clear();

    const second = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
      Cl.uint(11),
    ]);

    const secondRun = await indexer.run();

    expect(secondRun.eventsProcessed).toBe(1);
    expect(trace.getEvents().map((event) => event.txId)).toStrictEqual([second.txId]);

    trace.clear();

    const thirdRun = await indexer.run();

    expect(thirdRun.eventsProcessed).toBe(0);
    expect(trace.getEvents()).toStrictEqual([]);
  });

  describe("with handler writes through context.db", () => {
    const directories: string[] = [];

    afterAll(() => {
      for (const directory of directories) {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    test("applies each event once across a failed batch and a restart", async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "stacksindex-devnet-"));
      directories.push(directory);
      const database = pglite(directory);
      const startBlock = (await chainTip()) + 1;
      const contracts = [{ contractId: EVENTS_CONTRACT, startBlock }];

      await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [Cl.uint(20)]);

      const counting: DevnetHandler = async (_event, { db }) => {
        await countEvent(db);
      };

      {
        await using indexer = await createDevnetIndexer({
          contracts,
          database,
          migrations,
          handler: counting,
        });

        const firstRun = await indexer.run();

        expect(firstRun.eventsProcessed).toBe(1);
        await expect(readCount(indexer.db)).resolves.toBe(1);
      }

      const second = await submitContractCall(RUNTIME_SENDER, EVENTS_CONTRACT, "set-value", [
        Cl.uint(21),
      ]);

      {
        // Only the new event is pending, and the run fails right after writing it.
        const crash = new Error("crash after the write");

        await using indexer = await createDevnetIndexer({
          contracts,
          database,
          migrations,
          handler: async (event, { db }) => {
            await countEvent(db);
            expect(event.txId).toBe(second.txId);
            throw crash;
          },
        });

        await expect(indexer.run()).rejects.toMatchObject({ cause: crash });
        // The write rolled back with the checkpoint.
        await expect(readCount(indexer.db)).resolves.toBe(1);
      }

      await using restarted = await createDevnetIndexer({
        contracts,
        database,
        migrations,
        handler: counting,
      });

      const resumed = await restarted.run();

      expect(resumed.eventsProcessed).toBe(1);
      await expect(readCount(restarted.db)).resolves.toBe(2);
    });
  });
});
