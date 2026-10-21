import { Context, Effect, Layer, Ref } from "effect";

import type { IndexerDatabase } from "../database/index.ts";
import type { SyncStoreError } from "../lib/errors.ts";
import { syncStore } from "../sync-store/index.ts";

/**
 * Where the indexer is in its lifecycle:
 * - `idle`: no `run`/`live` call yet, or the last one was interrupted
 * - `backfill`: the historical pass is running
 * - `live`: the historical pass finished and `live` follows new heads
 * - `done`: the last `run` finished, or `live` reached every `endBlock`
 * - `failed`: the last `run`/`live` call failed
 */
export type IndexerPhase = "idle" | "backfill" | "live" | "done" | "failed";

/** In-memory phase of the indexer, one per `Indexer` layer. */
export class RunPhase extends Context.Service<RunPhase, Ref.Ref<IndexerPhase>>()(
  "stacksindex/runtime/RunPhase",
) {
  static readonly layer = Layer.effect(RunPhase, Ref.make<IndexerPhase>("idle"));
}

export interface IndexerStatus {
  chainId: number;
  phase: IndexerPhase;
  /** True once the historical pass finished: phase is "live" or "done". Use for readiness probes. */
  ready: boolean;
  /** Height through which every event has been indexed, or `null` before the first batch. */
  checkpoint: { blockHeight: number; blockTime: number; finalizedBlockHeight: number } | null;
  /** Chain tip read at the start of the latest pass, or `null` before the first pass. */
  anchor: { blockHeight: number } | null;
  /** Sync progress of every defined contract, keyed by definition name. */
  contracts: Record<string, ContractStatus>;
}

export interface ContractStatus {
  /** Every event at or below this height is stored; `null` before the contract's first sync. */
  syncedBlockHeight: number | null;
  /** True once the contract synced through its `endBlock`. */
  isComplete: boolean;
}

/** Reads the phase and the stored progress; the database is the source of truth across restarts. */
export const readIndexerStatus = (
  chainId: number,
  contracts: readonly { readonly name: string; readonly contractId: string }[],
): Effect.Effect<IndexerStatus, SyncStoreError, IndexerDatabase | RunPhase> =>
  Effect.gen(function* () {
    const phase = yield* Ref.get(yield* RunPhase);

    const [checkpoint, anchor, progress] = yield* Effect.all([
      syncStore.getCheckpoint({ chainId }),
      syncStore.getSyncAnchor({ chainId }),
      syncStore.listSyncProgress({ chainId }),
    ]);

    const progressById = new Map(progress.map((row) => [row.contractId, row]));
    const contractStatuses: Record<string, ContractStatus> = {};

    for (const contract of contracts) {
      const row = progressById.get(contract.contractId);

      contractStatuses[contract.name] = {
        syncedBlockHeight: row === undefined ? null : Number(row.syncedBlockHeight),
        isComplete: row?.isComplete ?? false,
      };
    }

    return {
      chainId,
      phase,
      ready: phase === "live" || phase === "done",
      checkpoint:
        checkpoint === null
          ? null
          : {
              blockHeight: Number(checkpoint.blockHeight),
              blockTime: Number(checkpoint.blockTime),
              finalizedBlockHeight: Number(checkpoint.finalizedBlockHeight),
            },
      anchor: anchor === null ? null : { blockHeight: anchor.blockHeight },
      contracts: contractStatuses,
    };
  });
