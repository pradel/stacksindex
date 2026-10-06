import { sql } from "drizzle-orm";
import { createHistoricalRuntime, type IndexerDb } from "stacksindex";

export interface TestDatabase {
  db: IndexerDb;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const runtime = await createHistoricalRuntime({ database: { kind: "pglite" } });

  await runtime.migrate();

  return {
    db: runtime.db,

    async cleanup() {
      await runtime.db.execute(
        sql`truncate table "transactions", "blocks", "sync_progress", "events", "checkpoints" cascade`,
      );
    },

    async close() {
      await runtime.close();
    },
  };
}
