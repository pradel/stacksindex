import fs from "node:fs";
import path from "node:path";

import { afterAll, describe, expect, test } from "vite-plus/test";

import { createHistoricalRuntime } from "../compat/promise.ts";
import { blocksTable, eventsTable } from "../sync-store/schema.ts";

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
    const runtime = await createHistoricalRuntime({ database: { kind: "pglite" } });

    await runtime.migrate();

    // Verify tables exist and queries work through the promise facade
    const blocks = await runtime.db.select().from(blocksTable);
    expect(blocks).toStrictEqual([]);

    const events = await runtime.db.select().from(eventsTable);
    expect(events).toStrictEqual([]);

    await runtime.close();
  });

  test("creates pglite database with directory and applies migrations", async () => {
    const tempDir = path.resolve(import.meta.dirname, `../../test-data-${Date.now()}`);
    tempDirs.push(tempDir);

    const runtime = await createHistoricalRuntime({
      database: {
        kind: "pglite",
        directory: tempDir,
      },
    });

    await runtime.migrate();

    const blocks = await runtime.db.select().from(blocksTable);
    expect(blocks).toStrictEqual([]);

    await runtime.close();
    expect(fs.existsSync(tempDir)).toBe(true);
  });

  test("close is idempotent and further calls reject after closing", async () => {
    const runtime = await createHistoricalRuntime({ database: { kind: "pglite" } });

    await runtime.close();
    await runtime.close();

    await expect(runtime.migrate()).rejects.toThrow("HistoricalRuntime is closed");
  });
});
