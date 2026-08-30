import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import { HandlerExecutionError } from "../lib/errors.ts";
import { startClock } from "../lib/timer.ts";
import type { FilterBounds, HandlerContext, HandlerEvent, Handlers } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";

interface IndexingContext {
  logger: Logger;
  db: NodePgDatabase | PgliteDatabase;
  client: HandlerContext["client"];
  handlers: Handlers;
  bounds: Record<string, FilterBounds | undefined>;
}

export const createIndexing = (context: IndexingContext) => ({
  async executeEvent(event: HandlerEvent): Promise<Result<void, HandlerExecutionError>> {
    const handler = context.handlers[event.contract_log.contract_id];

    if (handler === undefined) {
      context.logger.debug({
        msg: "No handler found for event",
        contractId: event.contract_log.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
      });
      return Result.ok(undefined);
    }

    const bounds = context.bounds[event.contract_log.contract_id];
    const { startBlock, endBlock } = bounds ?? {};
    if (
      (startBlock !== undefined && event.block_height < startBlock) ||
      (endBlock !== undefined && event.block_height > endBlock)
    ) {
      context.logger.debug({
        msg: "Event outside filter bounds, skipping",
        contractId: event.contract_log.contract_id,
        blockHeight: event.block_height,
        startBlock,
        endBlock,
      });
      return Result.ok(undefined);
    }

    const handlerClock = startClock();
    try {
      await handler(event, { db: context.db, client: context.client });
    } catch (err) {
      const duration = handlerClock();
      context.logger.error({
        msg: "Error executing event handler",
        contractId: event.contract_log.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
        error: err,
        duration,
      });
      return Result.err(
        new HandlerExecutionError({
          cause: err instanceof Error ? err : new Error(String(err)),
          contractId: event.contract_log.contract_id,
        }),
      );
    }

    const duration = handlerClock();
    context.logger.debug({
      msg: "Executed event handler",
      contractId: event.contract_log.contract_id,
      eventType: event.event_type,
      blockHeight: event.block_height,
      duration,
    });

    return Result.ok(undefined);
  },
});
