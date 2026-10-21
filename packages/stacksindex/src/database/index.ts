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
import type { MigrationConfig } from "drizzle-orm/migrator";
import { Context, Effect, Layer, Redacted, type Scope } from "effect";

import { DatabaseError, MigrationError } from "../lib/errors.ts";
import { STACKSINDEX_SCHEMA } from "../sync-store/schema.ts";

export type IndexerDb<TRelations extends AnyRelations = AnyRelations> =
  | PgliteEffectPgDatabase<TRelations>
  | PgEffectPgDatabase<TRelations>;

/** Where the indexer stores its data; build it with `pglite` or `postgres`. */
export type Database =
  | {
      readonly kind: "pglite";
      readonly directory?: string;
    }
  | {
      readonly kind: "postgres";
      readonly connectionString: string;
    };

/** Embedded PGlite, persisted in `directory` or kept in memory without one. */
export const pglite = (directory?: string): Database =>
  directory === undefined ? { kind: "pglite" } : { kind: "pglite", directory };

/** PostgreSQL reached through `connectionString` (`postgres://user:pass@host:5432/db`). */
export const postgres = (connectionString: string): Database => ({
  kind: "postgres",
  connectionString,
});

/** The indexer's own migrations, shipped next to the build output. */
function internalMigrationsFolder(): string {
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

const runMigrations = (
  db: IndexerDb,
  config: MigrationConfig,
): Effect.Effect<void, MigrationError> =>
  // SAFETY: Both IndexerDb variants expose the same migrator session surface.
  migratePglite(db as PgliteEffectPgDatabase, config).pipe(
    Effect.asVoid,
    Effect.mapError((cause) => new MigrationError({ cause })),
  );

/**
 * Creates or upgrades the indexer's own tables. Their bookkeeping lives in
 * `stacksindex.__drizzle_migrations`, apart from the user's migrations.
 */
const migrateInternal = (db: IndexerDb): Effect.Effect<void, MigrationError> =>
  runMigrations(db, {
    migrationsFolder: internalMigrationsFolder(),
    migrationsSchema: STACKSINDEX_SCHEMA,
  });

export interface DatabaseOptions {
  /**
   * Drizzle relations from `defineRelations`, enabling `db.query` on the
   * database handle.
   */
  relations?: AnyRelations;
  /**
   * Folder of the user's drizzle-kit migrations, applied after the indexer's
   * own and tracked in drizzle's default `drizzle.__drizzle_migrations`.
   */
  migrations?: string;
}

const connect = (
  config: Database,
  options?: DatabaseOptions,
): Effect.Effect<IndexerDb, DatabaseError, Scope.Scope> =>
  Effect.gen(function* () {
    const drizzleConfig = { relations: options?.relations };

    if (config.kind === "pglite") {
      const clientContext = yield* Layer.build(
        PgliteClient.layer(config.directory ? { dataDir: config.directory } : {}),
      ).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "connect", cause })));

      return yield* makePgliteWithDefaults(drizzleConfig).pipe(Effect.provide(clientContext));
    }

    const clientContext = yield* Layer.build(
      PgClient.layer({
        url: Redacted.make(config.connectionString),
      }),
    ).pipe(Effect.mapError((cause) => new DatabaseError({ operation: "connect", cause })));

    return yield* makePgWithDefaults(drizzleConfig).pipe(Effect.provide(clientContext));
  });

export class IndexerDatabase extends Context.Service<IndexerDatabase, IndexerDb>()(
  "stacksindex/database/IndexerDatabase",
  {
    make: Effect.die("IndexerDatabase must be provided via IndexerDatabase.layer"),
  },
) {
  /** Opens the database, then creates or upgrades the indexer's tables and the user's. */
  static readonly layer = (
    config: Database,
    options?: DatabaseOptions,
  ): Layer.Layer<IndexerDatabase, DatabaseError | MigrationError> =>
    Layer.effect(
      IndexerDatabase,
      connect(config, options).pipe(
        Effect.tap(migrateInternal),
        Effect.tap((db) =>
          options?.migrations === undefined
            ? Effect.void
            : runMigrations(db, { migrationsFolder: options.migrations }),
        ),
      ),
    );

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
