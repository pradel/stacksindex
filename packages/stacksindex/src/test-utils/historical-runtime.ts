/**
 * Runs the historical indexer from tests: contracts and block sources go
 * straight to `Indexer.layer`, without a `defineIndexer` definition.
 */
import { Effect, Logger, References } from "effect";

import { IndexerDatabase, type IndexerDb } from "../database/index.ts";
import type { CoreHandler } from "../lib/types.ts";
import { toThenable } from "../promise/thenable.ts";
import type { BlockSourceSpec } from "../runtime/blocks.ts";
import type { ContractSpec } from "../runtime/contracts.ts";
import { Indexer, type IndexerOptions } from "../runtime/index.ts";

/** A contract as tests pass it to `makeRuntime().run`; the name defaults to the id's contract name. */
export interface TestContract {
  readonly contractId: string;
  readonly handler: CoreHandler;
  readonly name?: string;
  readonly startBlock?: number;
  readonly endBlock?: number | "latest";
}

export const contractSpec = ({ name, ...contract }: TestContract): ContractSpec => ({
  name: name ?? contract.contractId.slice(contract.contractId.indexOf(".") + 1),
  onInvalid: "fail",
  ...contract,
});

/**
 * `logger`, when set, receives the run's warnings and errors; otherwise
 * nothing is logged.
 */
export const makeRuntime = (
  input: { db: IndexerDb; logger?: Logger.Logger<unknown, unknown> } & IndexerOptions,
) => ({
  run: (contracts: readonly TestContract[], blocks: readonly BlockSourceSpec[] = []) =>
    toThenable(
      Effect.gen(function* () {
        const indexer = yield* Indexer;

        return yield* indexer.run;
      }).pipe(
        Effect.provide(
          Indexer.layer({
            chain: input.chain,
            api: input.api,
            finality: input.finality,
            contracts: contracts.map(contractSpec),
            blocks,
          }),
        ),
        Effect.provideService(IndexerDatabase, input.db),
        Effect.provide(Logger.layer(input.logger === undefined ? [] : [input.logger])),
        Effect.provideService(
          References.MinimumLogLevel,
          input.logger === undefined ? "None" : "Warn",
        ),
      ),
    ),
});
