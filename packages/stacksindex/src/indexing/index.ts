import { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { StacksApiError } from "../datasources/api/errors.ts";
import { datasourceStacksApi } from "../datasources/api/index.ts";
import { HandlerExecutionError } from "../lib/errors.ts";
import { startClock } from "../lib/timer.ts";
import type { HandlerEvent, Handlers, IndexingClient } from "../lib/types.ts";
import type { Logger } from "../logger/index.ts";

interface IndexingContext {
  logger: Logger;
  db: NodePgDatabase | PgliteDatabase;
  handlers: Handlers;
  api?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export const createIndexing = (context: IndexingContext) => ({
  async executeEvent(event: HandlerEvent): Promise<Result<void, HandlerExecutionError>> {
    const endClock = startClock();
    const handler = context.handlers[event.contract_log.contract_id];

    if (handler === undefined) {
      const duration = endClock();
      context.logger.debug({
        msg: "No handler found for event",
        contractId: event.contract_log.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
        txIndex: event.tx_index,
        duration,
      });
      return Result.ok(undefined);
    }

    const handlerClock = startClock();
    try {
      const client: IndexingClient = {
        // oxlint-disable-next-line typescript/no-explicit-any
        callReadOnly(...args: [any, ...any[]]): Promise<Result<any, StacksApiError>> {
          const apiContext = {
            logger: context.logger,
            api: context.api,
          };

          // oxlint-disable-next-line typescript/no-unsafe-assignment
          const [firstArg, secondArg, thirdArg] = args;
          if (typeof firstArg === "object" && firstArg !== null && "abi" in firstArg) {
            // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access
            const customTip = firstArg.tip;
            // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-type-assertion
            return datasourceStacksApi.typedCallReadFunction(apiContext, {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              ...(firstArg as Parameters<typeof datasourceStacksApi.typedCallReadFunction>[1]),
              tip: typeof customTip === "number" ? customTip : event.block_height,
            });
          }

          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const contractId = firstArg as string;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const functionName = secondArg as string;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const options = thirdArg as
            | { args?: string[]; sender?: string; tip?: number }
            | undefined;

          return datasourceStacksApi.callReadFunction(apiContext, contractId, functionName, {
            ...options,
            tip: options?.tip ?? event.block_height,
          });
        },
      };

      await handler(event, { db: context.db, client });
      const duration = handlerClock();
      context.logger.debug({
        msg: "Executed event handler",
        contractId: event.contract_log.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
        txIndex: event.tx_index,
        duration,
      });
    } catch (err) {
      const duration = handlerClock();
      context.logger.error({
        msg: "Error executing event handler",
        contractId: event.contract_log.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
        txIndex: event.tx_index,
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

    const duration = endClock();
    context.logger.debug({
      msg: "Executed event",
      contractId: event.contract_log.contract_id,
      eventType: event.event_type,
      blockHeight: event.block_height,
      txIndex: event.tx_index,
      duration,
    });

    return Result.ok(undefined);
  },
});
