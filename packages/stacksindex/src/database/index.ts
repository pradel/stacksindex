import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PgClient } from "@effect/sql-pg";
import { PgliteClient } from "@effect/sql-pglite";
import type { AnyRelations } from "drizzle-orm";
import {
  type EffectPgDatabase as PgliteEffectPgDatabase,
  makeWithDefaults as makePgliteWithDefaults,
} from "drizzle-orm/effect-pglite";
import { migrate as migratePglite } from "drizzle-orm/effect-pglite/migrator";
import {
  type EffectPgDatabase as PgEffectPgDatabase,
  makeWithDefaults as makePgWithDefaults,
} from "drizzle-orm/effect-postgres";
import { Context, Effect, Layer, Redacted, type Scope } from "effect";

import { DatabaseError, MigrationError } from "../lib/errors.ts";

export type IndexerDb<TRelations extends AnyRelations = AnyRelations> =
  | PgliteEffectPgDatabase<TRelations>
  | PgEffectPgDatabase<TRelations>;

export type DatabaseConfig =
  | {
      kind: "pglite";
      directory?: string;
    }
  | {
      kind: "postgres";
      connectionString: string;
    };

export function getMigrationsFolder(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidate1 = path.resolve(currentDir, "../../drizzle");

  if (fs.existsSync(candidate1)) {
    return candidate1;
  }

  const candidate2 = path.resolve(currentDir, "../drizzle");

  if (fs.existsSync(candidate2)) {
    return candidate2;
  }

  return candidate1;
}

export function migrate(options?: {
  migrationsFolder?: string;
}): Effect.Effect<void, MigrationError, IndexerDatabase> {
  const migrationsFolder = options?.migrationsFolder ?? getMigrationsFolder();

  return Effect.gen(function* () {
    const indexerDb = yield* IndexerDatabase;

    // SAFETY: Both IndexerDb variants expose the same migrator session surface.
    yield* migratePglite(indexerDb as PgliteEffectPgDatabase, { migrationsFolder }).pipe(
      Effect.asVoid,
      Effect.mapError((cause) => new MigrationError({ cause })),
    );
  });
}

export class IndexerDatabase extends Context.Service<IndexerDatabase, IndexerDb>()(
  "stacksindex/database/IndexerDatabase",
  {
    make: Effect.die("IndexerDatabase must be provided via IndexerDatabase.layer"),
  },
) {
  static readonly layer = (config: DatabaseConfig): Layer.Layer<IndexerDatabase, DatabaseError> => {
    if (config.kind === "pglite") {
      return Layer.unwrap(
        Effect.gen(function* () {
          const clientContext = yield* Layer.build(
            PgliteClient.layer(config.directory ? { dataDir: config.directory } : {}),
          ).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "connect", cause })));

          return Layer.effect(
            IndexerDatabase,
            Effect.gen(function* dbLayer() {
              const db = yield* makePgliteWithDefaults();

              // SAFETY: makePgliteWithDefaults resolves a pglite Effect database, a member of IndexerDb.
              return db as IndexerDb;
            }).pipe(Effect.provide(clientContext)),
          );
        }),
      );
    }

    return Layer.unwrap(
      Effect.gen(function* () {
        const clientContext = yield* Layer.build(
          PgClient.layer({
            url: Redacted.make(config.connectionString),
          }),
        ).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "connect", cause })));

        return Layer.effect(
          IndexerDatabase,
          Effect.gen(function* dbLayer() {
            const db = yield* makePgWithDefaults();

            // SAFETY: makePgWithDefaults resolves a postgres Effect database, a member of IndexerDb.
            return db as IndexerDb;
          }).pipe(Effect.provide(clientContext)),
        );
      }),
    );
  };

  static readonly transaction = <A, E, R>(
    f: (db: IndexerDb) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | DatabaseError, R | IndexerDatabase> =>
    Effect.gen(function* () {
      const indexerDb = yield* IndexerDatabase;

      // SAFETY: Both IndexerDb variants expose the same transaction surface, and its handle satisfies IndexerDb.
      const db = indexerDb as PgliteEffectPgDatabase;

      return yield* db
        .transaction((tx) => {
          // SAFETY: Drizzle's transaction handle exposes the same query surface as IndexerDb.
          const transactionDb = tx as IndexerDb;

          return f(transactionDb).pipe(Effect.provideService(IndexerDatabase, transactionDb));
        })
        .pipe(
          Effect.catchTag("SqlError", (cause) =>
            Effect.fail(new DatabaseError({ operation: "transaction", cause })),
          ),
        );
    });
}

export function makeDatabase(config: DatabaseConfig): Effect.Effect<
  {
    db: IndexerDb;
    migrate: (options?: { migrationsFolder?: string }) => Effect.Effect<void, MigrationError>;
  },
  DatabaseError,
  Scope.Scope
> {
  return Effect.gen(function* () {
    if (config.kind === "pglite") {
      const clientContext = yield* Layer.build(
        PgliteClient.layer(config.directory ? { dataDir: config.directory } : {}),
      ).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "connect", cause })));

      const db = yield* makePgliteWithDefaults().pipe(Effect.provide(clientContext));

      return {
        db,
        migrate: (options?: { migrationsFolder?: string }) =>
          migrate(options).pipe(Effect.provideService(IndexerDatabase, db)),
      };
    }

    const clientContext = yield* Layer.build(
      PgClient.layer({
        url: Redacted.make(config.connectionString),
      }),
    ).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "connect", cause })));

    const db = yield* makePgWithDefaults().pipe(Effect.provide(clientContext));

    return {
      db,
      migrate: (options?: { migrationsFolder?: string }) =>
        migrate(options).pipe(Effect.provideService(IndexerDatabase, db)),
    };
  });
}
