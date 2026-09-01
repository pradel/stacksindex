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
        callReadOnly(options: any): Promise<Result<any, StacksApiError>> {
          const apiContext = {
            logger: context.logger,
            api: context.api,
          };

          // oxlint-disable-next-line typescript/no-unsafe-member-access
          if (options.abi !== undefined) {
            // oxlint-disable-next-line typescript/no-unsafe-argument
            return datasourceStacksApi.typedCallReadFunction(apiContext, {
              ...options,
              // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access
              tip: options.tip ?? event.block_height,
            });
          }

          // oxlint-disable-next-line typescript/no-unsafe-member-access
          const contractId = `${options.contractAddress}.${options.contractName}`;
          // oxlint-disable-next-line typescript/no-unsafe-member-access, typescript/no-unsafe-type-assertion
          const sender = (options.senderAddress ?? options.sender) as string | undefined;

          return datasourceStacksApi.callReadFunction(
            apiContext,
            contractId,
            // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-member-access
            options.functionName,
            {
              // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access
              args: options.args,
              sender,
              // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access
              tip: options.tip ?? event.block_height,
            },
          );
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
