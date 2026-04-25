import type { NodePgDatabase } from "drizzle-orm/node-postgres";

export interface LogEvent {
  type: "log";
}

export type Event = LogEvent;

export interface HandlerEvent {
  event_index: number;
  event_type: string;
  tx_id: string;
  contract_id: string;
  topic: string;
  value_hex: string;
  value_repr: string;
  block_height: number;
  block_time: number;
  tx_index: number;
  sender_address: string;
}

export interface HandlerContext {
  db: NodePgDatabase;
}

export type EventHandler = (event: HandlerEvent, context: HandlerContext) => Promise<void>;

export type Handlers = Record<string, Record<string, EventHandler[]> | undefined>;
