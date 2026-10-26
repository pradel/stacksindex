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
import { type MigrationConfig, readMigrationFiles } from "drizzle-orm/migrator";
import { Context, Effect, Layer, Redacted, type Scope } from "effect";

import { DatabaseError, MigrationError } from "../lib/errors.ts";
import { STACKSINDEX_SCHEMA, versionTable } from "../sync-store/schema.ts";

/**
 * Format of the data this version stores in the `stacksindex` schema. Raise it
 * when a release changes what stored data means, so databases written before
 * fail to open and are re-synced instead of misread.
 */
export const DATA_VERSION = 1;

export type IndexerDb<TRelations extends AnyRelations = AnyRelations> =
  | PgliteEffectPgDatabase<TRelations>
  | PgEffectPgDatabase<TRelations>;

/** The SQL client under the database `connect` builds. */
type DatabaseClient = PgClient.PgClient | PgliteClient.PgliteClient;

/** The database `connect` builds, unlike a transaction handle, exposes its SQL client. */
type ConnectedDb = IndexerDb & { readonly $client: DatabaseClient };

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
 *
 * Fails when the database knows a migration this version does not ship, or
 * stores another data format: it was written by another stacksindex version.
 * A database without a recorded format predates it and holds the first one.
 */
const migrateInternal = (db: ConnectedDb): Effect.Effect<void, MigrationError> =>
  Effect.gen(function* () {
    const migrationsFolder = internalMigrationsFolder();

    const shipped = new Set(
      readMigrationFiles({ migrationsFolder }).map((migration) => migration.name),
    );

    const [{ exists }] = yield* db.$client.unsafe<{ exists: boolean }>(
      `select to_regclass('"${STACKSINDEX_SCHEMA}"."__drizzle_migrations"') is not null as exists`,
    );

    const applied = exists
      ? yield* db.$client.unsafe<{ name: string | null }>(
          `select name from "${STACKSINDEX_SCHEMA}"."__drizzle_migrations"`,
        )
      : [];

    const unknown = applied.find((row) => row.name !== null && !shipped.has(row.name));

    if (unknown !== undefined) {
      return yield* new MigrationError({
        cause: new Error(
          `The indexer database was upgraded by a newer stacksindex (migration ${unknown.name}); upgrade stacksindex to open it.`,
        ),
      });
    }

    yield* runMigrations(db, { migrationsFolder, migrationsSchema: STACKSINDEX_SCHEMA });

    const [stored] = yield* db.select().from(versionTable).limit(1);

    if (stored === undefined) {
      yield* db.insert(versionTable).values({ dataVersion: DATA_VERSION });

      return;
    }

    if (stored.dataVersion !== DATA_VERSION) {
      return yield* new MigrationError({
        cause: new Error(
          stored.dataVersion > DATA_VERSION
            ? `The indexer database holds data format ${stored.dataVersion}, written by a newer stacksindex; upgrade stacksindex to open it.`
            : `The indexer database holds data format ${stored.dataVersion}, which this stacksindex (format ${DATA_VERSION}) cannot read. Re-sync from an empty database: drop the "${STACKSINDEX_SCHEMA}" schema and reset your tables.`,
        ),
      });
    }
  }).pipe(
    Effect.mapError((cause) =>
      cause instanceof MigrationError ? cause : new MigrationError({ cause }),
    ),
  );

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
): Effect.Effect<ConnectedDb, DatabaseError, Scope.Scope> =>
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
  /**
   * Opens the database, then creates or upgrades the indexer's tables and the
   * user's. Processes opening the same Postgres database at once migrate one
   * after the other.
   */
  static readonly layer = (
    config: Database,
    options?: DatabaseOptions,
  ): Layer.Layer<IndexerDatabase, DatabaseError | MigrationError> =>
    Layer.effect(
      IndexerDatabase,
      connect(config, options).pipe(
        Effect.tap((db) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* advisoryLock(db.$client, "stacksindex:migrations", { wait: true });
              yield* migrateInternal(db);

              if (options?.migrations !== undefined) {
                yield* runMigrations(db, { migrationsFolder: options.migrations });
              }
            }),
          ),
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

  /**
   * Takes the lock of `chainId`'s indexer until the scope closes. Resolves
   * `false`, holding nothing, when another session holds it.
   */
  static readonly lock = (
    chainId: number,
  ): Effect.Effect<boolean, DatabaseError, IndexerDatabase | Scope.Scope> =>
    Effect.gen(function* () {
      // SAFETY: Outside transactions the service holds the database `connect` built.
      const db = (yield* IndexerDatabase) as ConnectedDb;

      // One 64-bit key per chain, so indexers of different chains share a database.
      return yield* advisoryLock(db.$client, `stacksindex:${chainId}`, { wait: false });
    });
}

/**
 * Takes the session-level advisory lock on `key` on a connection reserved
 * until the scope closes, waiting for it with `wait`, else resolving `false`
 * when another session holds it. Postgres releases it when the connection
 * drops, so a crashed process does not keep it.
 *
 * PGlite runs in this process on a single connection that reserving would
 * block, and no other process can open it, so it holds nothing there.
 */
function advisoryLock(
  client: DatabaseClient,
  key: string,
  options: { readonly wait: boolean },
): Effect.Effect<boolean, DatabaseError, Scope.Scope> {
  if ("pglite" in client) {
    return Effect.succeed(true);
  }

  return Effect.gen(function* () {
    const connection = yield* client.reserve;
    const lock = options.wait ? "pg_advisory_lock" : "pg_try_advisory_lock";

    const [row] = yield* connection.execute(
      `select ${lock}(hashtextextended($1, 0)) as locked`,
      [key],
      undefined,
    );

    // `pg_advisory_lock` returns once it holds the lock, and no value.
    if (!options.wait && row?.locked !== true) {
      return false;
    }

    // Runs before the connection returns to the pool, so it never leaves holding the lock.
    yield* Effect.addFinalizer(() =>
      connection
        .execute("select pg_advisory_unlock(hashtextextended($1, 0))", [key], undefined)
        .pipe(Effect.ignore),
    );

    return true;
  }).pipe(
    Effect.catchTag("SqlError", (cause) =>
      Effect.fail(new DatabaseError({ operation: "lock", cause })),
    ),
  );
}
