import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { asc, eq } from "drizzle-orm";
import { integer, pgSchema, text } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, test } from "vite-plus/test";

import { createIndexer, type Indexer } from "../promise/index.ts";
import { blocksTable } from "../sync-store/schema.ts";
import { pglite } from "./index.ts";

const catalogTables = pgSchema("information_schema").table("tables", {
  tableSchema: text("table_schema").notNull(),
  tableName: text("table_name").notNull(),
});

const tablesIn = async (indexer: Indexer, schema: string): Promise<string[]> => {
  const rows = await indexer.db
    .select({ tableName: catalogTables.tableName })
    .from(catalogTables)
    .where(eq(catalogTables.tableSchema, schema))
    .orderBy(asc(catalogTables.tableName));

  return rows.map((row) => row.tableName);
};

const migrationNames = async (indexer: Indexer, schema: string): Promise<string[]> => {
  const migrations = pgSchema(schema).table("__drizzle_migrations", {
    id: integer().notNull(),
    name: text().notNull(),
  });

  const rows = await indexer.db
    .select({ name: migrations.name })
    .from(migrations)
    .orderBy(asc(migrations.id));

  return rows.map((row) => row.name);
};

describe("database", () => {
  const tempDirs: string[] = [];

  const makeTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stacksindex-db-"));
    tempDirs.push(dir);

    return dir;
  };

  afterAll(() => {
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  const writeUserMigration = (): string => {
    const migrationsFolder = makeTempDir();
    const migrationDir = path.join(migrationsFolder, "20260101000000_user_events");
    fs.mkdirSync(migrationDir);
    // `events` is also an indexer table name; the schemas keep them apart.
    fs.writeFileSync(
      path.join(migrationDir, "migration.sql"),
      'CREATE TABLE "events" ("id" text PRIMARY KEY);',
    );

    return migrationsFolder;
  };

  test("creates the indexer tables in the stacksindex schema when opened", async () => {
    await using indexer = await createIndexer({ database: pglite() });

    await expect(tablesIn(indexer, "stacksindex")).resolves.toStrictEqual([
      "__drizzle_migrations",
      "blocks",
      "checkpoints",
      "events",
      "sync_anchors",
      "sync_progress",
      "transactions",
    ]);
    await expect(tablesIn(indexer, "public")).resolves.toStrictEqual([]);
    await expect(indexer.db.select().from(blocksTable)).resolves.toStrictEqual([]);
  });

  test("reopens an existing pglite directory without reapplying indexer migrations", async () => {
    const directory = makeTempDir();

    const first = await createIndexer({ database: pglite(directory) });
    const appliedOnCreate = await migrationNames(first, "stacksindex");
    await first.close();

    await using reopened = await createIndexer({ database: pglite(directory) });

    await expect(migrationNames(reopened, "stacksindex")).resolves.toStrictEqual(appliedOnCreate);
  });

  test("migrations applies user migrations to public without colliding with indexer tables", async () => {
    const migrations = writeUserMigration();

    await using indexer = await createIndexer({ database: pglite(), migrations });

    await expect(tablesIn(indexer, "public")).resolves.toStrictEqual(["events"]);
    await expect(migrationNames(indexer, "drizzle")).resolves.toStrictEqual([
      "20260101000000_user_events",
    ]);
    await expect(migrationNames(indexer, "stacksindex")).resolves.not.toContain(
      "20260101000000_user_events",
    );
  });

  test("reopening with the same migrations does not reapply them", async () => {
    const directory = makeTempDir();
    const migrations = writeUserMigration();

    const first = await createIndexer({ database: pglite(directory), migrations });
    await first.close();

    await using reopened = await createIndexer({ database: pglite(directory), migrations });

    await expect(migrationNames(reopened, "drizzle")).resolves.toStrictEqual([
      "20260101000000_user_events",
    ]);
  });

  test("close is idempotent and further calls reject after closing", async () => {
    const indexer = await createIndexer({ database: pglite() });

    await indexer.close();
    await indexer.close();

    await expect(indexer.status()).rejects.toThrow("Indexer is closed");
  });
});
