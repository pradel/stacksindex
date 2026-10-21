import { sql } from "drizzle-orm";
import { createIndexer, type Indexer, type IndexerDb, pglite } from "stacksindex";

export interface TestDatabase {
  db: IndexerDb;
  /** Indexer on this database: scenarios run their filters through it. */
  indexer: Indexer;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const indexer = await createIndexer({ database: pglite(), logLevel: "None" });

  return {
    db: indexer.db,
    indexer,

    async cleanup() {
      await indexer.db.execute(
        sql`truncate table "stacksindex"."transactions", "stacksindex"."blocks", "stacksindex"."sync_progress", "stacksindex"."events", "stacksindex"."checkpoints", "stacksindex"."sync_anchors" cascade`,
      );
    },

    async close() {
      await indexer.close();
    },
  };
}
