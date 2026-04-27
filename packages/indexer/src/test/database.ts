import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";

export interface TestDatabase {
  db: PgliteDatabase;
  client: PGlite;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
}

// oxlint-disable-next-line func-style typescript/require-await
export async function createTestDatabase(): Promise<TestDatabase> {
  const client = new PGlite();
  const db = drizzle({ client });

  await migrate(db, { migrationsFolder: "drizzle" });

  return {
    db,
    client,

    async cleanup() {
      await db.execute(
        sql`truncate table "transactions", "blocks", "sync_progress", "events", "checkpoints" cascade`,
      );
    },

    async close() {
      await client.close();
    },
  };
}
