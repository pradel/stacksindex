import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { asc, eq } from "drizzle-orm";
import { integer, pgSchema, text } from "drizzle-orm/pg-core";
import { afterAll, describe, expect, test } from "vite-plus/test";

import { defineIndexer, type Indexer } from "../promise/index.ts";
import { blocksTable } from "../sync-store/schema.ts";
import { freshDatabase, persistentDatabase } from "../test/fresh-database.ts";
import type { Database } from "./index.ts";

const definition = defineIndexer({ contracts: { token: { id: "SP123.token" } } });

const open = (database: Database, migrations?: string) =>
  definition.create({
    database,
    migrations,
    logLevel: "None",
    handlers: { token: () => undefined },
  });

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

  test("creates the indexer tables in the stacksindex schema when opened", async () => {
    await using indexer = await open(await freshDatabase());

    await expect(tablesIn(indexer, "stacksindex")).resolves.toStrictEqual([
      "__drizzle_migrations",
      "block_sync_progress",
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

  test("reopens an existing database without reapplying indexer migrations", async () => {
    const database = await persistentDatabase(makeTempDir());

    const first = await open(database);
    const appliedOnCreate = await migrationNames(first, "stacksindex");
    await first.close();

    await using reopened = await open(database);

    await expect(migrationNames(reopened, "stacksindex")).resolves.toStrictEqual(appliedOnCreate);
  });

  test("applies user migrations to public at open without colliding with indexer tables", async () => {
    const migrationsFolder = makeTempDir();
    const migrationDir = path.join(migrationsFolder, "20260101000000_user_events");
    fs.mkdirSync(migrationDir);
    // `events` is also an indexer table name; the schemas keep them apart.
    fs.writeFileSync(
      path.join(migrationDir, "migration.sql"),
      'CREATE TABLE "events" ("id" text PRIMARY KEY);',
    );

    await using plain = await open(await freshDatabase());
    await using indexer = await open(await freshDatabase(), migrationsFolder);

    await expect(tablesIn(indexer, "public")).resolves.toStrictEqual(["events"]);
    await expect(tablesIn(indexer, "stacksindex")).resolves.toContain("events");
    await expect(migrationNames(indexer, "drizzle")).resolves.toStrictEqual([
      "20260101000000_user_events",
    ]);
    await expect(migrationNames(indexer, "stacksindex")).resolves.toStrictEqual(
      await migrationNames(plain, "stacksindex"),
    );
  });

  test("reopening with the same migrations does not reapply them", async () => {
    const database = await persistentDatabase(makeTempDir());
    const migrationsFolder = makeTempDir();
    const migrationDir = path.join(migrationsFolder, "20260101000000_user_events");
    fs.mkdirSync(migrationDir);
    fs.writeFileSync(
      path.join(migrationDir, "migration.sql"),
      'CREATE TABLE "events" ("id" text PRIMARY KEY);',
    );

    const first = await open(database, migrationsFolder);
    await first.close();

    await using reopened = await open(database, migrationsFolder);

    await expect(migrationNames(reopened, "drizzle")).resolves.toStrictEqual([
      "20260101000000_user_events",
    ]);
  });

  test("close is idempotent and further calls reject after closing", async () => {
    const indexer = await open(await freshDatabase());

    await indexer.close();
    await indexer.close();

    await expect(indexer.run()).rejects.toThrow("Indexer is closed");
    await expect(indexer.status()).rejects.toThrow("Indexer is closed");
  });
});
