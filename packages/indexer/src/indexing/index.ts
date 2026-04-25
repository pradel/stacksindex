import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";

import { startClock } from "../lib/timer.ts";
import type { HandlerEvent, Handlers } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";

interface IndexingContext {
  logger: Logger;
  db: NodePgDatabase;
  handlers: Handlers;
}

// oxlint-disable-next-line arrow-body-style
export const createIndexing = (context: IndexingContext) => {
  return {
    async executeEvent(event: HandlerEvent): Promise<Result<void, Error>> {
      const endClock = startClock();
      const contractHandlers = context.handlers[event.contract_id];
      const handlers = contractHandlers ? (contractHandlers[event.event_type] ?? []) : [];

      if (handlers.length === 0) {
        const duration = endClock();
        context.logger.debug({
          msg: "No handler found for event",
          contractId: event.contract_id,
          eventType: event.event_type,
          blockHeight: event.block_height,
          duration,
        });
        return Result.ok(undefined);
      }

      for (const handler of handlers) {
        const handlerClock = startClock();
        try {
          // oxlint-disable-next-line no-await-in-loop
          await handler(event, { db: context.db });
          const duration = handlerClock();
          context.logger.debug({
            msg: "Executed event handler",
            contractId: event.contract_id,
            eventType: event.event_type,
            blockHeight: event.block_height,
            duration,
          });
        } catch (err) {
          const duration = handlerClock();
          context.logger.error({
            msg: "Error executing event handler",
            contractId: event.contract_id,
            eventType: event.event_type,
            blockHeight: event.block_height,
            error: err,
            duration,
          });
          return Result.err(err instanceof Error ? err : new Error(String(err)));
        }
      }

      const duration = endClock();
      context.logger.debug({
        msg: "Executed event",
        contractId: event.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
        duration,
      });

      return Result.ok(undefined);
    },
  };
};
