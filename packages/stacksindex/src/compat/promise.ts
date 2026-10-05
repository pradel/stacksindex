import { Effect } from "effect";

import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import {
  HistoricalRuntime,
  type Filter,
  type HistoricalRuntimeOptions,
} from "../runtime/historical.ts";

export interface PromiseHistoricalRuntime {
  run: (filters: Filter[]) => Promise<void>;
}

export interface PromiseHistoricalRuntimeOptions extends HistoricalRuntimeOptions {
  db: IndexerDb;
}

export function createHistoricalRuntime(
  input: PromiseHistoricalRuntimeOptions,
): PromiseHistoricalRuntime {
  const { db, ...options } = input;

  return {
    run: (filters: Filter[]): Promise<void> =>
      Effect.runPromise(
        Effect.gen(function* () {
          const runtime = yield* HistoricalRuntime;
          yield* runtime.run(filters);
        }).pipe(
          Effect.provide(HistoricalRuntime.layer(options)),
          Effect.provideService(IndexerDatabase, db),
        ),
      ),
  };
}
