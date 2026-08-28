import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { NodePgDatabase, drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { type PgliteDatabase, drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";

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
  db: NodePgDatabase | PgliteDatabase;
  migrate: () => Promise<void>;
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

export async function createDatabase(config: DatabaseConfig): Promise<DatabaseResult> {
  const migrationsFolder = getMigrationsFolder();

  if (config.kind === "pglite") {
    const client = config.directory ? new PGlite(config.directory) : new PGlite();
    await client.waitReady;
    const db = drizzlePglite({ client });
    return {
      db,
      migrate: async () => {
        await migratePglite(db, { migrationsFolder });
      },
      close: async () => {
        await client.close();
      },
    };
  }

  const db = drizzleNodePg({ connection: config.connectionString });
  return {
    db,
    migrate: async () => {
      await migrateNodePg(db, { migrationsFolder });
    },
    close: async () => {
      await db.$client.end();
    },
  };
}

export async function migrate(indexerDb: PgliteDatabase | NodePgDatabase): Promise<void> {
  const migrationsFolder = getMigrationsFolder();
  if (indexerDb instanceof NodePgDatabase) {
    await migrateNodePg(indexerDb, { migrationsFolder });
  } else {
    await migratePglite(indexerDb, { migrationsFolder });
  }
}
