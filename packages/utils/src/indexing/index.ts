import { Result } from "better-result";

import { startClock } from "../lib/timer.ts";
import type { Logger } from "../logger/index.ts";

interface IndexingContext {
  logger: Logger;
}

// oxlint-disable-next-line arrow-body-style
export const createIndexing = (context: IndexingContext) => {
  return {
    executeEvent(event: Event): Promise<Result<void, unknown>> {
      const endClock = startClock();

      return Result.tryPromise({
        // oxlint-disable-next-line typescript/require-await
        try: async () => {
          const duration = endClock();
          context.logger.debug({
            msg: "Executed event",
            event,
            duration,
          });
        },
        catch: (err) => {
          const duration = endClock();
          context.logger.error({
            msg: "Error executing event",
            error: err,
            duration,
          });
          // TODO create a retry mechanism for failed events
          // TODO return error if retry is failing
        },
      });
    },
  };
};
