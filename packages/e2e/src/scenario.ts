import { sql, type SQL } from "drizzle-orm";
import type { Filter, Indexer } from "stacksindex";
import { expect } from "vite-plus/test";

import { createTestDatabase, type TestDatabase } from "./test-db.ts";
import { createTraceCollector, type RecordedTraceEvent, type TraceCollector } from "./tracer.ts";

function isRowsResult<Row>(value: unknown): value is { rows: Row[] } {
  return (
    typeof value === "object" && value !== null && "rows" in value && Array.isArray(value.rows)
  );
}

export async function selectRows<Row>(database: TestDatabase["db"], query: SQL): Promise<Row[]> {
  const result = await database.execute(query);

  if (Array.isArray(result)) {
    return result;
  }

  return isRowsResult<Row>(result) ? result.rows : [];
}

export interface ScenarioDatabase {
  readonly db: TestDatabase["db"];
  readonly indexer: Indexer;
  setup: () => Promise<void>;
  reset: () => Promise<void>;
  teardown: () => Promise<void>;
}

export function createScenarioDatabase(): ScenarioDatabase {
  let testDb: TestDatabase | undefined = undefined;

  const current = (): TestDatabase => {
    if (!testDb) {
      throw new Error("Scenario database is not set up. Call setup() in beforeAll.");
    }

    return testDb;
  };

  return {
    get db(): TestDatabase["db"] {
      return current().db;
    },

    get indexer(): Indexer {
      return current().indexer;
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
  database: ScenarioDatabase;
  contracts: ScenarioContract[];
}): Promise<ScenarioOutcome> {
  const tracer = createTraceCollector();

  const filters: Filter[] = options.contracts.map((contract) => ({
    contractId: contract.contractId,
    startBlock: contract.startBlock,
    endBlock: contract.endBlock,
    handler: (event) => {
      tracer.record(contract.contractId, event);
    },
  }));

  await options.database.indexer.run(filters);

  return { tracer, events: tracer.getEvents() };
}

export interface ExpectedSyncProgress {
  cursor: string | null;
  syncedBlockHeight: number;
  isComplete: boolean;
}

export async function expectProgress(
  database: TestDatabase["db"],
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

export async function expectCheckpoint(
  database: TestDatabase["db"],
  height: number,
): Promise<void> {
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
    sql`select "height" from "stacksindex"."blocks"`,
  );

  expect(
    rows
      .map((row) => Number(row.height))
      .sort((leftHeight, rightHeight) => leftHeight - rightHeight),
  ).toStrictEqual(heights);
}
