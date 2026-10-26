import { Effect } from "effect";

import { IndexerDatabase } from "../database/index.ts";
import { ConfigurationError, type DatabaseError, type SyncStoreError } from "../lib/errors.ts";
import { syncStore } from "../sync-store/index.ts";
import type { RecordedContract } from "../sync-store/schema.ts";
import type { ContractSpec } from "./contracts.ts";

/** The contracts in `specs` as `meta` records them, ordered by id. */
const toRecordedContracts = (specs: readonly ContractSpec[]): RecordedContract[] =>
  specs
    .map((spec) => ({
      id: spec.contractId,
      startBlock: spec.startBlock ?? null,
      endBlock: spec.endBlock ?? null,
    }))
    .toSorted((a, b) => (a.id < b.id ? -1 : 1));

/**
 * Compares the defined contracts with the ones recorded in the database by
 * the previous `run` or `live`, then records them.
 *
 * Indexing resumes from one checkpoint shared by every contract, and a
 * contract's saved sync progress takes precedence over its `startBlock`. So a
 * contract added with events at or below what was already processed, or a
 * changed block range on a processed contract, would silently leave events
 * unindexed. Those changes fail with `ConfigurationError` and record nothing.
 * Removing a contract, renaming one, and every change before anything was
 * processed are accepted. A database processed by a version that recorded no
 * contracts adopts the current ones.
 */
export function checkContractDefinitions(
  chainId: number,
  specs: readonly ContractSpec[],
): Effect.Effect<void, ConfigurationError | SyncStoreError | DatabaseError, IndexerDatabase> {
  const contracts = toRecordedContracts(specs);

  return IndexerDatabase.transaction(() =>
    Effect.gen(function* () {
      const recorded = yield* syncStore.getRecordedContracts({ chainId });

      // Compared field by field: jsonb does not keep the key order.
      if (
        recorded !== null &&
        recorded.length === contracts.length &&
        recorded.every(
          (contract, index) =>
            contract.id === contracts[index].id &&
            contract.startBlock === contracts[index].startBlock &&
            contract.endBlock === contracts[index].endBlock,
        )
      ) {
        return;
      }

      const checkpoint = yield* syncStore.getCheckpoint({ chainId });
      const indexedHeight = checkpoint === null ? undefined : Number(checkpoint.blockHeight);

      if (recorded === null) {
        if (indexedHeight !== undefined) {
          yield* Effect.logWarning(
            `No contracts recorded for a database indexed up to block ${indexedHeight}; recording the current ones`,
          ).pipe(Effect.annotateLogs({ chainId, phase: "init" }));
        }

        yield* syncStore.recordContracts({ chainId, contracts });

        return;
      }

      const syncedHeights = new Map(
        (yield* syncStore.listSyncProgress({ chainId })).map((row) => [
          row.contractId,
          Number(row.syncedBlockHeight),
        ]),
      );

      const recordedById = new Map(recorded.map((contract) => [contract.id, contract]));

      const problems = specs.flatMap((spec) => {
        const before = recordedById.get(spec.contractId);
        const syncedHeight = syncedHeights.get(spec.contractId);

        const problem =
          before === undefined
            ? addedContractProblem(spec, indexedHeight, syncedHeight)
            : changedRangeProblem(spec, before, indexedHeight, syncedHeight);

        return problem === undefined ? [] : [problem];
      });

      if (problems.length > 0) {
        return yield* new ConfigurationError({
          message: [
            "The contracts differ from the ones this database was indexed with:",
            ...problems.map((problem) => `- ${problem}`),
            "Revert the change, or call `reindex` to index every stored event again with it.",
          ].join("\n"),
        });
      }

      const definedIds = new Set(contracts.map((contract) => contract.id));

      yield* Effect.logInfo("Recording changed contracts").pipe(
        Effect.annotateLogs({
          chainId,
          phase: "init",
          added: contracts.flatMap((contract) =>
            recordedById.has(contract.id) ? [] : [contract.id],
          ),
          removed: recorded.flatMap((contract) =>
            definedIds.has(contract.id) ? [] : [contract.id],
          ),
        }),
      );

      yield* syncStore.recordContracts({ chainId, contracts });
    }),
  );
}

/**
 * Makes the next `run` or `live` index every stored event from the start
 * with `specs`, keeping the fetched chain data: `clearTables` empties the
 * tables the handlers write, then the checkpoint is deleted, contracts added
 * or whose block range changed since they were recorded lose their sync
 * progress (so they are fetched over their new range), and `specs` are
 * recorded. All in one transaction.
 */
export function resetIndexing<E>(
  chainId: number,
  specs: readonly ContractSpec[],
  clearTables: Effect.Effect<void, E, IndexerDatabase>,
): Effect.Effect<void, E | SyncStoreError | DatabaseError, IndexerDatabase> {
  const contracts = toRecordedContracts(specs);

  return IndexerDatabase.transaction(() =>
    Effect.gen(function* () {
      yield* clearTables;

      const recorded = yield* syncStore.getRecordedContracts({ chainId });

      // Without a record, there is no known range for the progress to differ from.
      if (recorded !== null) {
        const recordedById = new Map(recorded.map((contract) => [contract.id, contract]));

        yield* syncStore.deleteSyncProgress({
          chainId,
          contractIds: contracts.flatMap((contract) => {
            const before = recordedById.get(contract.id);

            return before?.startBlock === contract.startBlock &&
              before.endBlock === contract.endBlock
              ? []
              : [contract.id];
          }),
        });
      }

      yield* syncStore.deleteCheckpoint({ chainId });
      yield* syncStore.recordContracts({ chainId, contracts });
    }),
  );
}

/**
 * Why adding `spec` would leave its events unindexed, or `undefined` when it
 * would not. Its saved progress, left if it was defined before, resumes where
 * it stopped, so a start above both heights only skips unprocessed blocks.
 */
function addedContractProblem(
  spec: ContractSpec,
  indexedHeight: number | undefined,
  syncedHeight: number | undefined,
): string | undefined {
  const processedHeight = Math.max(indexedHeight ?? -1, syncedHeight ?? -1);

  if (processedHeight < 0 || (spec.startBlock !== undefined && spec.startBlock > processedHeight)) {
    return undefined;
  }

  return `contracts.${spec.name} (${spec.contractId}) was added after blocks up to ${processedHeight} were processed: its events at or below that block would never reach its handler. Set its startBlock above ${processedHeight} to index only newer events.`;
}

/**
 * Why changing the block range `recorded` for `spec`'s contract would leave
 * events unindexed or wrongly indexed, or `undefined` when it would not.
 */
function changedRangeProblem(
  spec: ContractSpec,
  recorded: RecordedContract,
  indexedHeight: number | undefined,
  syncedHeight: number | undefined,
): string | undefined {
  const startBlock = spec.startBlock ?? null;
  const endBlock = spec.endBlock ?? null;

  if (recorded.startBlock === startBlock && recorded.endBlock === endBlock) {
    return undefined;
  }

  const label = `contracts.${spec.name} (${spec.contractId})`;

  const [from, to] = [recorded, { startBlock, endBlock }].map(
    (range) => `startBlock ${range.startBlock ?? "unset"}, endBlock ${range.endBlock ?? "unset"}`,
  );

  if (indexedHeight !== undefined) {
    return `${label} changed from ${from} to ${to} after indexing reached block ${indexedHeight}: events indexed under the old range are kept and the new range is not backfilled.`;
  }

  // Before indexing, only a lower start matters: saved progress resumes above it.
  if (syncedHeight !== undefined && (startBlock ?? 0) < (recorded.startBlock ?? 0)) {
    return `${label} changed from ${from} to ${to} after it was synced: the blocks below the old startBlock would never be fetched.`;
  }

  return undefined;
}
