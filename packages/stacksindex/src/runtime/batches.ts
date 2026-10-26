/**
 * Maximum number of events indexed in a single database transaction. A batch
 * can exceed this when a single block contains more events, because batches are
 * only split at block boundaries.
 */
export const MAX_BATCH_EVENTS = 1000;

/**
 * Splits stored rows (events and block source runs) into batches that always
 * end on a block boundary, so a checkpoint written after a batch refers to a
 * fully processed block. A batch is closed once it holds at least
 * `maxBatchSize` rows and the next block starts; a single block larger than
 * `maxBatchSize` stays in one batch.
 */
export function chunkEventsByBlock<TRow extends { readonly blockHeight: bigint }>(
  events: readonly TRow[],
  maxBatchSize: number = MAX_BATCH_EVENTS,
): TRow[][] {
  const batches: TRow[][] = [];
  let batch: TRow[] = [];
  let currentBlockHeight: number | undefined = undefined;

  for (const event of events) {
    const blockHeight = Number(event.blockHeight);

    if (
      currentBlockHeight !== undefined &&
      blockHeight !== currentBlockHeight &&
      batch.length >= maxBatchSize
    ) {
      batches.push(batch);
      batch = [];
    }

    batch.push(event);
    currentBlockHeight = blockHeight;
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
}
