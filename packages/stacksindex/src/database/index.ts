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
import { Context, Effect, Exit, Layer, Redacted, Scope } from "effect";

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

export function migrate(
  indexerDb: IndexerDb,
  options?: { migrationsFolder?: string },
): Effect.Effect<void, unknown> & PromiseLike<void> {
  const migrationsFolder = options?.migrationsFolder ?? getMigrationsFolder();
  const effect = (
    migratePglite(indexerDb as PgliteEffectPgDatabase, { migrationsFolder }) as Effect.Effect<
      void,
      unknown
    >
  ).pipe(Effect.asVoid);
  return toThenable(effect) as Effect.Effect<void, unknown> & PromiseLike<void>;
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
        return db as IndexerDb;
      }),
    );
    return Layer.provide(dbLayer, clientLayer);
  };
}

export function toThenable<T>(target: T): T {
  if (!target || (typeof target !== "object" && typeof target !== "function")) {
    return target;
  }
  return new Proxy(target, {
    get(t, prop, receiver) {
      if (prop === "then" && Effect.isEffect(t)) {
        // oxlint-disable-next-line typescript/no-explicit-any
        return (resolve: any, reject: any) => Effect.runPromise(t as any).then(resolve, reject);
      }
      const orig = Reflect.get(t, prop, receiver);
      if (typeof orig === "function") {
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
        migrate: (options?: { migrationsFolder?: string }) => migrate(db, options),
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
      migrate: (options?: { migrationsFolder?: string }) => migrate(db, options),
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
