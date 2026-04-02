import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";

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

  // TODO apply migrations

  return {
    db,
    client,

    async cleanup() {
      await db.execute(sql`drop schema if exists public cascade`);
      await db.execute(sql`create schema public`);
      await db.execute(sql`drop schema if exists drizzle cascade`);
    },

    async close() {
      await client.close();
    },
  };
}
