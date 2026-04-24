import { Result } from "better-result";

import type { StacksApiError } from "../datasources/api/errors.ts";
import { datasourceStacksApi, type ContractLog } from "../datasources/api/index.ts";
import type { Logger } from "../logger/index.ts";

interface HistoricalSyncContext {
  logger: Logger;
}

export const createHistoricalSync = (context: HistoricalSyncContext) => {
  const contract = "SPGDS0Y17973EN5TCHNHGJJ9B31XWQ5YX8A36C9B.usdcx-poolv1";

  return {
    async getContractEventsFirstCursor(): Promise<string | null> {
      // TODO: find a way to get the first cursor of any contract events
      return Promise.resolve("7403216:2147483647:6:2");
    },

    async run(): Promise<Result<void, StacksApiError>> {
      let cursor = await this.getContractEventsFirstCursor();
      let eventsPage = await datasourceStacksApi.getContractLogs(context, contract, cursor);
      if (eventsPage.isErr()) {
        return Result.err(eventsPage.error);
      }
      let nextCursor = eventsPage.value.next_cursor;
      let events: ContractLog[] = eventsPage.value.results;

      while (nextCursor) {
        // oxlint-disable-next-line no-await-in-loop
        eventsPage = await datasourceStacksApi.getContractLogs(context, contract, nextCursor);
        if (eventsPage.isErr()) {
          return Result.err(eventsPage.error);
        }
        events = events.concat(eventsPage.value.results);
        // oxlint-disable-next-line no-useless-assignment
        cursor = nextCursor;
        nextCursor = eventsPage.value.next_cursor;
      }

      return Result.ok(undefined);
    },
  };
};
