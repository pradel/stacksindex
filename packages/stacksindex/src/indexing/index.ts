import { Result } from "better-result";
import type { ClarityAbi, ContractFunctionArgs, ContractFunctionName } from "clarity-abitype";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { StacksApiError } from "../datasources/api/errors.ts";
import {
  datasourceStacksApi,
  type DatasourceStacksApiContext,
  type TypedCallReadOnlyFunctionParameters,
  type UntypedCallReadOnlyFunctionParameters,
} from "../datasources/api/index.ts";
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
        callReadOnly<
          const TAbi extends ClarityAbi | readonly unknown[],
          TFunctionName extends ContractFunctionName<TAbi, "read_only">,
          const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
        >(
          options:
            | TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>
            | UntypedCallReadOnlyFunctionParameters,
          // oxlint-disable-next-line typescript/no-explicit-any
        ): Promise<Result<any, StacksApiError>> {
          const apiContext: DatasourceStacksApiContext = {
            logger: context.logger,
            api: context.api,
          };

          if ("abi" in options) {
            return datasourceStacksApi.typedCallReadFunction(apiContext, {
              ...options,
              tip: options.tip ?? event.block_height,
            });
          }

          const contractId = `${options.contractAddress}.${options.contractName}`;
          return datasourceStacksApi.callReadFunction(
            apiContext,
            contractId,
            options.functionName,
            {
              args: options.args,
              sender: options.senderAddress,
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
      return Result.ok(undefined);
    } catch (err) {
      const duration = handlerClock();
      context.logger.error({
        msg: "Error executing event handler",
        contractId: event.contract_log.contract_id,
        eventType: event.event_type,
        blockHeight: event.block_height,
        txIndex: event.tx_index,
        duration,
        error: err,
      });
      return Result.err(
        new HandlerExecutionError({
          contractId: event.contract_log.contract_id,
          cause: err,
        }),
      );
    }
  },
});
