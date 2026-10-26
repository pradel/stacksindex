import { Predicate } from "effect";

import { ConfigurationError } from "../lib/errors.ts";
import type { CoreBlockHandler } from "../lib/types.ts";

/** A block interval source: runs its handler every `interval` blocks from `startBlock`. */
export interface BlockDefinition {
  /** Blocks between two runs of the handler. Defaults to 1, every block. */
  readonly interval?: number;
  /** First block height the handler runs at; later runs are `startBlock + k * interval`. */
  readonly startBlock: number;
  /** Stop at this block height, or `"latest"` for the chain tip read when a run starts. */
  readonly endBlock?: number | "latest";
}

export type BlockDefinitions = Readonly<Record<string, BlockDefinition>>;

/** A block source as the runtime indexes it: definition and handler. */
export interface BlockSourceSpec {
  /** Definition name (the key in `blocks`). */
  readonly name: string;
  readonly interval: number;
  readonly startBlock: number;
  readonly endBlock?: number | "latest";
  readonly handler: CoreBlockHandler;
}

/** A block source spec whose `"latest"` end block has been resolved to a height. */
export interface ResolvedBlockSource extends Omit<BlockSourceSpec, "endBlock"> {
  readonly endBlock?: number;
}

/** The range and interval of a block source, as the syncer and the store see it. */
export interface BlockSourceRange {
  readonly interval: number;
  readonly startBlock: number;
  readonly endBlock?: number;
}

export const isBlockHeight = (value: unknown): value is number =>
  Predicate.isNumber(value) && Number.isSafeInteger(value) && value >= 0;

/** Whether `source` runs its handler at `height`. */
export const isBlockSourceHeight = (source: BlockSourceRange, height: number): boolean =>
  height >= source.startBlock &&
  (source.endBlock === undefined || height <= source.endBlock) &&
  (height - source.startBlock) % source.interval === 0;

/** The first height above `height` that `source` runs at, or `undefined` past its `endBlock`. */
export function nextBlockSourceHeight(
  source: BlockSourceRange,
  height: number,
): number | undefined {
  const from = height + 1;

  const next =
    from <= source.startBlock
      ? source.startBlock
      : source.startBlock +
        Math.ceil((from - source.startBlock) / source.interval) * source.interval;

  return source.endBlock !== undefined && next > source.endBlock ? undefined : next;
}

/**
 * Checks a block source definition map, throwing `ConfigurationError` on the
 * first problem so mistakes surface when the definition module loads.
 */
export function validateBlockDefinitions(blocks: BlockDefinitions): void {
  for (const [name, source] of Object.entries(blocks)) {
    const fail = (problem: string): never => {
      throw new ConfigurationError({ message: `blocks.${name}: ${problem}` });
    };

    if (
      source.interval !== undefined &&
      !(Number.isSafeInteger(source.interval) && source.interval >= 1)
    ) {
      fail(`\`interval\` must be a positive integer, got ${String(source.interval)}.`);
    }

    if (!isBlockHeight(source.startBlock)) {
      fail(`\`startBlock\` must be a non-negative integer, got ${String(source.startBlock)}.`);
    }

    if (
      source.endBlock !== undefined &&
      source.endBlock !== "latest" &&
      !isBlockHeight(source.endBlock)
    ) {
      fail(
        `\`endBlock\` must be a non-negative integer or "latest", got ${String(source.endBlock)}.`,
      );
    }

    if (Predicate.isNumber(source.endBlock) && source.startBlock > source.endBlock) {
      fail(`\`startBlock\` (${source.startBlock}) is after \`endBlock\` (${source.endBlock}).`);
    }
  }
}
