import type { RecordedTraceEvent, TraceCollector } from "indexer-e2e/src/tracer.ts";
import {
  createIndexer,
  type ClarityJsonValue,
  type Filter,
  type Indexer,
  type IndexerPhase,
  type LiveOptions,
} from "stacksindex";

import { DEVNET_API_URL, waitUntil } from "./chain.ts";

/** Indexer on a fresh in-memory database, reading the devnet API. */
export async function createDevnetIndexer(live?: LiveOptions): Promise<Indexer> {
  const indexer = await createIndexer({
    database: { kind: "pglite" },
    // Clarinet devnet uses the testnet chain id; only the API URL differs.
    network: "testnet",
    api: { baseUrl: DEVNET_API_URL },
    live,
    logLevel: "Warn",
  });

  // `status()` reads the indexer tables, so create them before the first run.
  await indexer.migrate();

  return indexer;
}

export type ContractRange = Omit<Filter, "handler">;

/** Filters whose handlers record every event into `trace`. */
export function tracedFilters(trace: TraceCollector, ranges: ContractRange[]): Filter[] {
  return ranges.map((range) => ({
    ...range,
    handler: (event) => trace.record(range.contractId, event),
  }));
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
