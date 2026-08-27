import type { PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as drizzleMgirate } from "drizzle-orm/pglite/migrator";

export { createLogger } from "./logger/index.ts";
export type { Logger } from "./logger/index.ts";
export { createHistoricalRuntime } from "./runtime/historical.ts";
export type { Filter, HistoricalRuntimeContext } from "./runtime/historical.ts";
export { datasourceStacksApi } from "./datasources/api/index.ts";
export type { CallReadResponse, DatasourceStacksApiContext } from "./datasources/api/index.ts";
export type {
  EventHandler,
  HandlerContext,
  HandlerEvent,
  Handlers,
  IndexingClient,
} from "./lib/types.ts";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function migrate(indexerDb: PgliteDatabase) {
  await drizzleMgirate(indexerDb, { migrationsFolder: `${__dirname}/../drizzle` });
}
