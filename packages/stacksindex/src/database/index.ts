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
import { Context, Effect, Exit, Layer, Predicate, Redacted, Scope } from "effect";

export type IndexerDb<TRelations extends AnyRelations = AnyRelations> =
  | PgliteEffectPgDatabase<TRelations>
  | PgEffectPgDatabase<TRelations>;

declare module "drizzle-orm/pg-core/effect/select" {
  interface PgEffectSelectBase<
    TTableName,
    TSelection,
    TSelectMode,
    TNullabilityMap,
    TDynamic,
    TExcludedMethods,
    TResult,
    TSelectedFields,
    TEffectHKT,
  > extends PromiseLike<TResult> {}
}

export type DatabaseConfig =
  | {
      kind: "pglite";
      directory?: string;
    }
  | {
      kind: "postgres";
      connectionString: string;
    };

export interface DatabaseResult {
  db: IndexerDb;
  migrate: (options?: { migrationsFolder?: string }) => Promise<void>;
  close: () => Promise<void>;
}

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
}): Effect.Effect<void, unknown, IndexerDatabase> {
  const migrationsFolder = options?.migrationsFolder ?? getMigrationsFolder();

  return Effect.gen(function* () {
    const indexerDb = yield* IndexerDatabase;

    // SAFETY: Both IndexerDb variants expose the same migrator session surface, and its concrete error union safely widens to `unknown`.
    yield* (
      migratePglite(indexerDb as PgliteEffectPgDatabase, { migrationsFolder }) as Effect.Effect<
        void,
        unknown
      >
    ).pipe(Effect.asVoid);
  });
}

export class IndexerDatabase extends Context.Service<IndexerDatabase, IndexerDb>()(
  "stacksindex/database/IndexerDatabase",
  {
    make: Effect.die("IndexerDatabase must be provided via IndexerDatabase.layer"),
  },
) {
  static readonly layer = (config: DatabaseConfig): Layer.Layer<IndexerDatabase, unknown> => {
    if (config.kind === "pglite") {
      const clientLayer = PgliteClient.layer(config.directory ? { dataDir: config.directory } : {});

      const dbLayer = Layer.effect(
        IndexerDatabase,
        Effect.gen(function* dbLayer() {
          const db = yield* makePgliteWithDefaults();

          // SAFETY: makePgliteWithDefaults resolves a pglite Effect database, a member of IndexerDb.
          return db as IndexerDb;
        }),
      );

      return Layer.provide(dbLayer, clientLayer);
    }

    const clientLayer = PgClient.layer({
      url: Redacted.make(config.connectionString),
    });

    const dbLayer = Layer.effect(
      IndexerDatabase,
      Effect.gen(function* dbLayer() {
        const db = yield* makePgWithDefaults();

        // SAFETY: makePgWithDefaults resolves a postgres Effect database, a member of IndexerDb.
        return db as IndexerDb;
      }),
    );

    return Layer.provide(dbLayer, clientLayer);
  };

  static readonly transaction = <A, E, R>(
    f: (db: IndexerDb) => Effect.Effect<A, E, R>,
  ): Effect.Effect<A, unknown, R | IndexerDatabase> =>
    Effect.gen(function* () {
      const indexerDb = yield* IndexerDatabase;

      // SAFETY: Both IndexerDb variants expose the same transaction surface, and its handle satisfies IndexerDb.
      const db = indexerDb as PgliteEffectPgDatabase;

      return yield* db.transaction((tx) => {
        // SAFETY: Drizzle's transaction handle exposes the same query surface as IndexerDb.
        const transactionDb = tx as IndexerDb;

        return f(transactionDb).pipe(Effect.provideService(IndexerDatabase, transactionDb));
      });
    });
}

function isProxyable<T>(target: T): target is T & object {
  return Boolean(target) && (typeof target === "object" || typeof target === "function");
}

type PromiseThenParameters = Parameters<Promise<unknown>["then"]>;

/**
 * Wraps an Effect so it can also be awaited as a Promise.
 */
export function toThenable<A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> & PromiseLike<A>;

export function toThenable<T>(target: T): T;

export function toThenable<T>(target: T): T {
  if (!isProxyable(target)) {
    return target;
  }

  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "then" && Effect.isEffect(t)) {
        // SAFETY: Effects reachable through toThenable are self-contained, so they carry no remaining requirements at run time.
        const runnable = t as Effect.Effect<unknown, unknown>;

        return (resolve: PromiseThenParameters[0], reject: PromiseThenParameters[1]) =>
          Effect.runPromise(runnable).then(resolve, reject);
      }

      // SAFETY: The Proxy get trap receives the property key being read from the target `t`.
      const orig = t[prop as keyof typeof t];

      if (Predicate.isFunction(orig)) {
        // oxlint-disable-next-line typescript/no-explicit-any
        return function get(this: any, ...args: any[]) {
          const res = orig.apply(this === receiver ? t : this, args);

          return toThenable(res);
        };
      }

      return orig;
    },
  });
}

export function makeDatabase(config: DatabaseConfig): Effect.Effect<
  {
    db: IndexerDb;
    migrate: (options?: { migrationsFolder?: string }) => Effect.Effect<void, unknown>;
  },
  unknown,
  Scope.Scope
> {
  return Effect.gen(function* () {
    if (config.kind === "pglite") {
      const clientContext = yield* Layer.build(
        PgliteClient.layer(config.directory ? { dataDir: config.directory } : {}),
      );

      const rawDb = yield* makePgliteWithDefaults().pipe(Effect.provide(clientContext));
      const db = toThenable(rawDb);

      return {
        db,
        migrate: (options?: { migrationsFolder?: string }) =>
          migrate(options).pipe(Effect.provideService(IndexerDatabase, rawDb)),
      };
    }

    const clientContext = yield* Layer.build(
      PgClient.layer({
        url: Redacted.make(config.connectionString),
      }),
    );

    const rawDb = yield* makePgWithDefaults().pipe(Effect.provide(clientContext));
    const db = toThenable(rawDb);

    return {
      db,
      migrate: (options?: { migrationsFolder?: string }) =>
        migrate(options).pipe(Effect.provideService(IndexerDatabase, rawDb)),
    };
  });
}

export async function createDatabase(config: DatabaseConfig): Promise<DatabaseResult> {
  const scope = await Effect.runPromise(Scope.make());

  const { db, migrate: runMigrate } = await Effect.runPromise(
    makeDatabase(config).pipe(Scope.provide(scope)),
  );

  return {
    db,
    migrate: async (options?: { migrationsFolder?: string }) => {
      await Effect.runPromise(runMigrate(options));
    },
    close: async () => {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    },
  };
}
