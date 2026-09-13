import { sql } from "drizzle-orm";
import { Effect, Exit, Scope } from "effect";

import { makeDatabase, type IndexerDb } from "../database/index.ts";

export interface TestDatabase {
  db: IndexerDb;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const scope = await Effect.runPromise(Scope.make());
  const { db, migrate } = await Effect.runPromise(
    makeDatabase({ kind: "pglite" }).pipe(Scope.provide(scope)),
  );

  await Effect.runPromise(migrate());

  return {
    db,

    async cleanup() {
      await Effect.runPromise(
        db.execute(
          sql`truncate table "transactions", "blocks", "sync_progress", "events", "checkpoints" cascade`,
        ),
      );
    },

    async close() {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
