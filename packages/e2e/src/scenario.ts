// oxlint-disable typescript/no-unsafe-member-access
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-assignment
import { sql, type SQL } from "drizzle-orm";
import { createHistoricalRuntime, type Filter, type Logger } from "stacksindex";
import { expect } from "vite-plus/test";

import { createTestDatabase, type TestDatabase } from "./test-db.ts";
import { createTraceCollector, type RecordedTraceEvent, type TraceCollector } from "./tracer.ts";

export async function selectRows<Row>(database: TestDatabase["db"], query: SQL): Promise<Row[]> {
  const result = (await database.execute(query)) as unknown as { rows: Row[] } | Row[];
  if (Array.isArray(result)) {
    return result;
  }
  return result.rows;
}

export interface ScenarioDatabase {
  readonly db: TestDatabase["db"];
  setup: () => Promise<void>;
  reset: () => Promise<void>;
  teardown: () => Promise<void>;
}

export function createScenarioDatabase(): ScenarioDatabase {
  let testDb: TestDatabase | undefined = undefined;

  return {
    get db(): TestDatabase["db"] {
      if (!testDb) {
        throw new Error("Scenario database is not set up. Call setup() in beforeAll.");
      }
      return testDb.db;
    },

    async setup(): Promise<void> {
      testDb = await createTestDatabase();
    },

    async reset(): Promise<void> {
      await testDb?.cleanup();
    },

    async teardown(): Promise<void> {
      await testDb?.close();
      testDb = undefined;
    },
  };
}

export type ScenarioContract = Omit<Filter, "handler">;

export interface ScenarioOutcome {
  tracer: TraceCollector;
  events: RecordedTraceEvent[];
}

export async function runScenario(options: {
  db: TestDatabase["db"];
  logger: Logger;
  contracts: ScenarioContract[];
}): Promise<ScenarioOutcome> {
  const tracer = createTraceCollector();
  const runtime = createHistoricalRuntime({ logger: options.logger, db: options.db });

  const filters: Filter[] = options.contracts.map((contract) => ({
    contractId: contract.contractId,
    startBlock: contract.startBlock,
    endBlock: contract.endBlock,
    handler: (event) => {
      tracer.record(contract.contractId, event);
      return Promise.resolve();
    },
  }));

  const result = await runtime.run(filters);
  expect(result.isOk()).toBe(true);

  return { tracer, events: tracer.getEvents() };
}

export interface ExpectedSyncProgress {
  cursor: string | null;
  lastBlockHeight: number;
  isComplete: boolean;
}

export async function expectProgress(
  database: TestDatabase["db"],
  contractId: string,
  expected: ExpectedSyncProgress,
): Promise<void> {
  const rows = await selectRows<{
    cursor: string | null;
    lastBlockHeight: string | number | bigint;
    isComplete: boolean;
  }>(
    database,
    sql`select "cursor", "lastBlockHeight", "is_complete" as "isComplete" from "sync_progress" where "contract_id" = ${contractId}`,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0].cursor).toBe(expected.cursor);
  expect(Number(rows[0].lastBlockHeight)).toBe(expected.lastBlockHeight);
  expect(rows[0].isComplete).toBe(expected.isComplete);
}

export async function expectCheckpoint(
  database: TestDatabase["db"],
  height: number,
): Promise<void> {
  const rows = await selectRows<{ blockHeight: string | number | bigint }>(
    database,
    sql`select "blockHeight" from "checkpoints"`,
  );
  expect(rows).toHaveLength(1);
  expect(Number(rows[0].blockHeight)).toBe(height);
}

const TABLE_COUNT_QUERIES = {
  blocks: sql`select count(*) as "count" from "blocks"`,
  checkpoints: sql`select count(*) as "count" from "checkpoints"`,
  events: sql`select count(*) as "count" from "events"`,
  sync_progress: sql`select count(*) as "count" from "sync_progress"`,
  transactions: sql`select count(*) as "count" from "transactions"`,
};

export type SyncTableName = keyof typeof TABLE_COUNT_QUERIES;

export async function expectTableCount(
  database: TestDatabase["db"],
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
  database: TestDatabase["db"],
  heights: number[],
): Promise<void> {
  const rows = await selectRows<{ height: string | number | bigint }>(
    database,
    sql`select "height" from "blocks"`,
  );
  expect(
    rows
      .map((row) => Number(row.height))
      .sort((leftHeight, rightHeight) => leftHeight - rightHeight),
  ).toStrictEqual(heights);
}
