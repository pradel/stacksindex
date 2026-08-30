import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migratePgLite } from "drizzle-orm/pglite/migrator";

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultMigrationsFolder(): string {
  // When bundled: <pkg>/dist/index.mjs -> <pkg>/dist/../drizzle
  // When running from source: <pkg>/src/sync-store/migrate.ts -> <pkg>/drizzle
  const candidates = [join(__dirname, "../drizzle"), join(__dirname, "../../drizzle")];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "meta", "_journal.json"))) {
      return candidate;
    }
  }
  return candidates[0];
}

/**
 * Apply stacksindex sync-store migrations.
 * Supports embedded PGlite databases as well as node-postgres backed databases.
 */
export async function migrate(
  db: PgliteDatabase | NodePgDatabase,
  options: { migrationsFolder?: string } = {},
): Promise<void> {
  // Drizzle exposes the underlying client as `$client` on PGlite databases.
  // PGlite clients expose `transaction()` and `close()`; node-postgres
  // Pools/clients expose neither.
  const client: unknown = "$client" in db ? db.$client : undefined;
  const isPgLite =
    typeof client === "object" && client !== null && "transaction" in client && "close" in client;

  const migrationsFolder = options.migrationsFolder ?? defaultMigrationsFolder();

  if (isPgLite) {
    await migratePgLite(db as PgliteDatabase, { migrationsFolder });
    return;
  }

  await migrateNodePg(db as NodePgDatabase, { migrationsFolder });
}
