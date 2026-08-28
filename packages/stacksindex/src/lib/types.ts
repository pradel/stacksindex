import type { Result } from "better-result";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { StacksApiError } from "../datasources/api/errors.ts";
import type { CallReadResponse, SmartContractLogEvent } from "../datasources/api/index.ts";

export interface LogEvent {
  type: "log";
}

export type Event = LogEvent;

export type HandlerEvent = SmartContractLogEvent & {
  block_height: number;
  block_time: number;
  tx_index: number;
  sender_address: string;
};

export interface IndexingClient {
  callReadOnly(
    contractId: string,
    functionName: string,
    options?: { args?: string[]; sender?: string; tip?: number },
  ): Promise<Result<CallReadResponse, StacksApiError>>;
}

// oxlint-disable-next-line typescript/no-explicit-any
export interface HandlerContext<TSchema extends Record<string, unknown> = any> {
  db: NodePgDatabase<TSchema> | PgliteDatabase<TSchema>;
  client: IndexingClient;
}

export type EventHandler = (event: HandlerEvent, context: HandlerContext) => Promise<void>;

export type Handlers = Record<string, EventHandler | undefined>;
