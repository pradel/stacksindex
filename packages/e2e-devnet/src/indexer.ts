import type { RecordedTraceEvent, TraceCollector } from "indexer-e2e/src/tracer.ts";
import {
  defineIndexer,
  pglite,
  type Database,
  type HandlerContext,
  type Indexer,
  type IndexerPhase,
  type LiveOptions,
  type PrintEvent,
} from "stacksindex";
import type { ClarityJsonValue } from "stacksindex/clarity";

import { DEVNET_API_URL, waitUntil } from "./chain.ts";

export interface ContractRange {
  contractId: string;
  startBlock?: number;
  endBlock?: number | "latest";
}

export type DevnetHandler = (event: PrintEvent, context: HandlerContext) => Promise<void> | void;

/** Definition name of a contract: its `<contract-name>` segment. */
export function contractName(contractId: string): string {
  return contractId.slice(contractId.indexOf(".") + 1);
}

/**
 * Indexer reading the devnet API, on a fresh in-memory database by default.
 * Every contract gets `handler`; with `trace`, events are recorded first.
 */
export function createDevnetIndexer(options: {
  contracts: ContractRange[];
  trace?: TraceCollector;
  handler?: DevnetHandler;
  live?: LiveOptions;
  database?: Database;
  migrations?: string;
}): Promise<Indexer> {
  const contracts = Object.fromEntries(
    options.contracts.map((range) => [
      contractName(range.contractId),
      { id: range.contractId, startBlock: range.startBlock, endBlock: range.endBlock },
    ]),
  );

  const handler: DevnetHandler = async (event, context) => {
    options.trace?.record(event);
    await options.handler?.(event, context);
  };

  return defineIndexer({ contracts }).create({
    database: options.database ?? pglite(),
    migrations: options.migrations,
    // Clarinet devnet uses the testnet chain id; only the API URL differs.
    chain: "testnet",
    api: { url: DEVNET_API_URL },
    live: options.live,
    logLevel: "Warn",
    handlers: Object.fromEntries(Object.keys(contracts).map((name) => [name, handler])),
  });
}

type PrintTuple = { event: string } & { [field: string]: ClarityJsonValue };

function isPrintTuple(value: ClarityJsonValue): value is PrintTuple {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.event === "string"
  );
}

/** The print tuple of an event emitted by `clarinet/contracts`. */
function printTuple(event: RecordedTraceEvent): PrintTuple {
  if (isPrintTuple(event.decoded)) {
    return event.decoded;
  }

  throw new Error(`Event ${event.txId}:${event.eventIndex} is not a named print tuple`);
}

/** The `event` field every print tuple in `clarinet/contracts` carries. */
export function printName(event: RecordedTraceEvent): string {
  return printTuple(event).event;
}

export function printField(event: RecordedTraceEvent, field: string): ClarityJsonValue {
  return printTuple(event)[field];
}

export async function waitForPhase(indexer: Indexer, phase: IndexerPhase): Promise<void> {
  await waitUntil(`the ${phase} phase`, async () =>
    (await indexer.status()).phase === phase ? true : undefined,
  );
}
