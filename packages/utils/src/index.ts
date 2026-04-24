import { createLogger } from "./logger/index.ts";
import { createHistoricalSync } from "./sync-historical/index.ts";
export { datasourceStacksApi } from "./datasources/api/index.ts";

const logger = createLogger({
  level: 5,
});

await createHistoricalSync({ logger }).run("SPGDS0Y17973EN5TCHNHGJJ9B31XWQ5YX8A36C9B.usdcx-poolv1");
