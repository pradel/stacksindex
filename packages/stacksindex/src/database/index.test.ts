import fs from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, test } from "vite-plus/test";

import { blocksTable, eventsTable } from "../sync-store/schema.ts";
import { createDatabase } from "./index.ts";

describe("database", () => {
  const tempDirs: string[] = [];

  afterAll(() => {
    for (const dir of tempDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  });

  test("creates in-memory pglite database and applies migrations via migrate()", async () => {
    const database = await createDatabase({ kind: "pglite" });

    await database.migrate();

    // Verify tables exist and queries work
    const blocks = await database.db.select().from(blocksTable);
    expect(blocks).toStrictEqual([]);

    const events = await database.db.select().from(eventsTable);
    expect(events).toStrictEqual([]);

    await database.close();
  });

  test("creates pglite database with directory and applies migrations", async () => {
    const tempDir = path.resolve(import.meta.dirname, `../../test-data-${Date.now()}`);
    tempDirs.push(tempDir);

    const database = await createDatabase({
      kind: "pglite",
      directory: tempDir,
    });

    await database.migrate();

    const blocks = await database.db.select().from(blocksTable);
    expect(blocks).toStrictEqual([]);

    await database.close();
    expect(fs.existsSync(tempDir)).toBe(true);
  });
});
