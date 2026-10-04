import { sql } from "drizzle-orm";
import { Context, Effect, Exit, Layer, Scope } from "effect";

import {
  IndexerDatabase,
  migrate as migrateDatabase,
  toThenable,
  type IndexerDb,
} from "../database/index.ts";

export interface TestDatabase {
  db: IndexerDb;
  cleanup: () => Promise<void>;
  close: () => Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const scope = await Effect.runPromise(Scope.make());

  const context = await Effect.runPromise(
    Layer.build(IndexerDatabase.layer({ kind: "pglite" })).pipe(Scope.provide(scope)),
  );

  const db = toThenable(Context.get(context, IndexerDatabase));

  await Effect.runPromise(migrateDatabase(db));

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
