import { createLogger } from "./logger/index.ts";
import { createHistoricalSync } from "./sync-historical/index.ts";
export { datasourceStacksApi } from "./datasources/api/index.ts";

const logger = createLogger({
  level: 5,
});

await createHistoricalSync({ logger }).run();
