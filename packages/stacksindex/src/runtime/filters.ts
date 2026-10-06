import { Effect, Predicate, Schema } from "effect";

import { type StacksApiError, StacksClient } from "../datasources/api/index.ts";
import { FilterValidationError } from "../lib/errors.ts";
import type { EventHandler } from "../lib/types.ts";

export interface Filter {
  contractId: string;
  handler: EventHandler;
  startBlock?: number;
  endBlock?: number | "latest";
}

export interface ResolvedFilter {
  contractId: string;
  handler: EventHandler;
  startBlock?: number;
  endBlock?: number;
}

const EventHandlerSchema = Schema.declare<EventHandler>((input): input is EventHandler =>
  Predicate.isFunction(input),
);

const FilterSchema = Schema.Struct({
  contractId: Schema.String,
  handler: EventHandlerSchema,
  startBlock: Schema.optional(Schema.Natural),
  endBlock: Schema.optional(Schema.Union([Schema.Natural, Schema.Literal("latest")])),
}).check(
  Schema.makeFilter((filter) => {
    if (
      filter.startBlock !== undefined &&
      Predicate.isNumber(filter.endBlock) &&
      filter.startBlock > filter.endBlock
    ) {
      return `Start block (${filter.startBlock}) is after end block (${filter.endBlock}) for contract '${filter.contractId}'.`;
    }

    return undefined;
  }),
);

const decodeFilters = Schema.decodeUnknownEffect(Schema.Array(FilterSchema));

/**
 * Validates user filters, resolves `"latest"` to the chain tip, and re-checks
 * the start/end ordering with the resolved value.
 */
export function validateAndResolveFilters(
  filters: Filter[],
): Effect.Effect<ResolvedFilter[], StacksApiError | FilterValidationError, StacksClient> {
  return Effect.gen(function* () {
    const client = yield* StacksClient;

    const decodedFilters = yield* decodeFilters(filters).pipe(
      Effect.mapError(
        (error) => new FilterValidationError({ message: `Validation failed: ${error.message}` }),
      ),
    );

    let latestBlockHeight: number | undefined = undefined;
    const hasLatestTag = decodedFilters.some((filter) => filter.endBlock === "latest");

    if (hasLatestTag) {
      const status = yield* client.getStatus();
      const chainTipHeight = status.chain_tip?.block_height;

      if (chainTipHeight === undefined) {
        return yield* Effect.fail(
          new FilterValidationError({
            message:
              "Validation failed: Unable to determine latest block height from API status response.",
          }),
        );
      }

      latestBlockHeight = chainTipHeight;
      yield* Effect.logInfo(`Resolved "latest" endBlock to block height ${latestBlockHeight}`).pipe(
        Effect.annotateLogs({ latestBlockHeight }),
      );
    }

    const resolvedFilters: ResolvedFilter[] = [];

    for (const filter of decodedFilters) {
      const resolvedEndBlock = filter.endBlock === "latest" ? latestBlockHeight : filter.endBlock;

      if (
        filter.startBlock !== undefined &&
        resolvedEndBlock !== undefined &&
        filter.startBlock > resolvedEndBlock
      ) {
        return yield* Effect.fail(
          new FilterValidationError({
            message: `Validation failed: Start block (${filter.startBlock}) is after end block (${resolvedEndBlock}) for contract '${filter.contractId}'.`,
          }),
        );
      }

      resolvedFilters.push({
        contractId: filter.contractId,
        handler: filter.handler,
        startBlock: filter.startBlock,
        endBlock: resolvedEndBlock,
      });
    }

    return resolvedFilters;
  });
}
