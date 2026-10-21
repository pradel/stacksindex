import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { sql, type SQL } from "drizzle-orm";
import {
  defineIndexer,
  pglite,
  type Database,
  type Indexer,
  type IndexerDb,
  type PrintEvent,
  type RunResult,
} from "stacksindex";
import { expect } from "vite-plus/test";

import { createTraceCollector, type RecordedTraceEvent, type TraceCollector } from "./tracer.ts";

function isRowsResult<Row>(value: unknown): value is { rows: Row[] } {
  return (
    typeof value === "object" && value !== null && "rows" in value && Array.isArray(value.rows)
  );
}

export async function selectRows<Row>(database: IndexerDb, query: SQL): Promise<Row[]> {
  const result = await database.execute(query);

  if (Array.isArray(result)) {
    return result;
  }

  return isRowsResult<Row>(result) ? result.rows : [];
}

type ScenarioIndexer = Indexer;

export interface ScenarioDatabase {
  /** Database of the indexer from the latest `runScenario`; still open until the next run or reset. */
  readonly db: IndexerDb;
  /** Runs a fresh indexer on this scenario's PGlite directory, closing the previous one first. */
  open: (
    createIndexer: (database: Database) => Promise<ScenarioIndexer>,
  ) => Promise<ScenarioIndexer>;
  setup: () => Promise<void>;
  reset: () => Promise<void>;
  teardown: () => Promise<void>;
}

export function createScenarioDatabase(): ScenarioDatabase {
  let directory: string | undefined = undefined;
  let current: ScenarioIndexer | undefined = undefined;

  async function closeCurrent(): Promise<void> {
    await current?.close();
    current = undefined;
  }

  async function removeDirectory(): Promise<void> {
    if (directory) {
      await fs.rm(directory, { recursive: true, force: true });
      directory = undefined;
    }
  }

  async function createDirectory(): Promise<void> {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "stacksindex-e2e-"));
  }

  return {
    get db(): IndexerDb {
      if (!current) {
        throw new Error("No scenario indexer is open. Call runScenario() first.");
      }

      return current.db;
    },

    async open(createIndexer) {
      if (!directory) {
        throw new Error("Scenario database is not set up. Call setup() in beforeAll.");
      }

      await closeCurrent();
      current = await createIndexer(pglite(directory));

      return current;
    },

    async setup(): Promise<void> {
      await createDirectory();
    },

    async reset(): Promise<void> {
      await closeCurrent();
      await removeDirectory();
      await createDirectory();
    },

    async teardown(): Promise<void> {
      await closeCurrent();
      await removeDirectory();
    },
  };
}

export interface ScenarioContract {
  contractId: string;
  startBlock?: number;
  endBlock?: number | "latest";
}

export interface ScenarioOutcome {
  result: RunResult;
  tracer: TraceCollector;
  events: RecordedTraceEvent[];
}

/** Definition name used for a contract: its `<contract-name>` segment. */
export function contractName(contractId: string): string {
  return contractId.slice(contractId.indexOf(".") + 1);
}

export async function runScenario(options: {
  database: ScenarioDatabase;
  contracts: ScenarioContract[];
}): Promise<ScenarioOutcome> {
  const tracer = createTraceCollector();

  const contracts = Object.fromEntries(
    options.contracts.map((contract) => [
      contractName(contract.contractId),
      { id: contract.contractId, startBlock: contract.startBlock, endBlock: contract.endBlock },
    ]),
  );

  const handlers = Object.fromEntries(
    Object.keys(contracts).map((name) => [
      name,
      (event: PrintEvent) => {
        tracer.record(event);
      },
    ]),
  );

  const app = await options.database.open((database) =>
    defineIndexer({ contracts }).create({ database, logLevel: "None", handlers }),
  );

  const result = await app.run();

  return { result, tracer, events: tracer.getEvents() };
}

export interface ExpectedSyncProgress {
  cursor: string | null;
  syncedBlockHeight: number;
  isComplete: boolean;
}

export async function expectProgress(
  database: IndexerDb,
  contractId: string,
  expected: ExpectedSyncProgress,
): Promise<void> {
  const rows = await selectRows<{
    cursor: string | null;
    syncedBlockHeight: string | number | bigint;
    isComplete: boolean;
  }>(
    database,
    sql`select "cursor", "syncedBlockHeight", "is_complete" as "isComplete" from "stacksindex"."sync_progress" where "contract_id" = ${contractId}`,
  );

  expect(rows).toHaveLength(1);
  expect(rows[0].cursor).toBe(expected.cursor);
  expect(Number(rows[0].syncedBlockHeight)).toBe(expected.syncedBlockHeight);
  expect(rows[0].isComplete).toBe(expected.isComplete);
}

export async function expectCheckpoint(database: IndexerDb, height: number): Promise<void> {
  const rows = await selectRows<{ blockHeight: string | number | bigint }>(
    database,
    sql`select "blockHeight" from "stacksindex"."checkpoints"`,
  );

  expect(rows).toHaveLength(1);
  expect(Number(rows[0].blockHeight)).toBe(height);
}

const TABLE_COUNT_QUERIES = {
  blocks: sql`select count(*) as "count" from "stacksindex"."blocks"`,
  checkpoints: sql`select count(*) as "count" from "stacksindex"."checkpoints"`,
  events: sql`select count(*) as "count" from "stacksindex"."events"`,
  sync_progress: sql`select count(*) as "count" from "stacksindex"."sync_progress"`,
  transactions: sql`select count(*) as "count" from "stacksindex"."transactions"`,
};

export type SyncTableName = keyof typeof TABLE_COUNT_QUERIES;

export async function expectTableCount(
  database: IndexerDb,
  table: SyncTableName,
  count: number,
): Promise<void> {
  const rows = await selectRows<{ count: string | number | bigint }>(
    database,
    TABLE_COUNT_QUERIES[table],
  );

  expect(Number(rows[0].count)).toBe(count);
}

export async function expectStoredBlockHeights(
  database: IndexerDb,
  heights: number[],
): Promise<void> {
  const rows = await selectRows<{ height: string | number | bigint }>(
    database,
    sql`select "height" from "stacksindex"."blocks"`,
  );

  expect(
    rows
      .map((row) => Number(row.height))
      .sort((leftHeight, rightHeight) => leftHeight - rightHeight),
  ).toStrictEqual(heights);
}
