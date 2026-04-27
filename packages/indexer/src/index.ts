import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as drizzleMgirate } from "drizzle-orm/pglite/migrator";

export { createLogger } from "./logger/index.ts";
export { createHistoricalRuntime } from "./runtime/historical.ts";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate(indexerDb: PgliteDatabase) {
  await drizzleMgirate(indexerDb, { migrationsFolder: `${__dirname}/../drizzle` });
}
