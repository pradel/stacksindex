import { sql } from "drizzle-orm";
import { createDatabase, type IndexerDb } from "stacksindex";

export interface TestDatabase {
  db: IndexerDb;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const dbResult = await createDatabase({ kind: "pglite" });

  await dbResult.migrate();

  return {
    db: dbResult.db,

    async cleanup() {
      await dbResult.db.execute(
        sql`truncate table "transactions", "blocks", "sync_progress", "events", "checkpoints" cascade`,
      );
    },

    async close() {
      await dbResult.close();
    },
  };
}
