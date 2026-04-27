import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";

import type { SmartContractLogEvent } from "../datasources/api/index.ts";

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

export interface HandlerContext {
  db: NodePgDatabase | PgliteDatabase;
}

export type EventHandler = (event: HandlerEvent, context: HandlerContext) => Promise<void>;

export type Handlers = Record<string, EventHandler | undefined>;
