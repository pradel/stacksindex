import { Effect } from "effect";

import {
  createHistoricalRuntime as createEffectHistoricalRuntime,
  type Filter,
  type HistoricalRuntimeContext,
} from "../runtime/historical.ts";

export interface HistoricalRuntime {
  run: (filters: Filter[]) => Promise<void>;
}

export function createHistoricalRuntime(input: HistoricalRuntimeContext): HistoricalRuntime {
  const runtime = createEffectHistoricalRuntime(input);
  return {
    run: (filters: Filter[]): Promise<void> => Effect.runPromise(runtime.run(filters)),
  };
}
