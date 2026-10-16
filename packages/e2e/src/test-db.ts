import { sql } from "drizzle-orm";
import { createIndexer, type IndexerDb } from "stacksindex";

export interface TestDatabase {
  db: IndexerDb;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const runtime = await createIndexer({ database: { kind: "pglite" } });

  await runtime.migrate();

  return {
    db: runtime.db,

    async cleanup() {
      await runtime.db.execute(
        sql`truncate table "transactions", "blocks", "sync_progress", "events", "checkpoints", "sync_anchors" cascade`,
      );
    },

    async close() {
      await runtime.close();
    },
  };
}
