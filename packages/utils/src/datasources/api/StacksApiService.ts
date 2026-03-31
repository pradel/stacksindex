import { Context, Effect } from "effect";
import type { Redacted } from "effect/Redacted";

import type { Block } from "./Block.js";
import type { StacksApiError } from "./Errors.js";

export interface StacksApiServiceConfig {
  readonly baseUrl: string;
  readonly apiKey?: Redacted;
}

export interface StacksApiService {
  readonly fetchBlock: (height: bigint) => Effect.Effect<Block, StacksApiError>;
}

export const StacksApiService = Context.GenericTag<StacksApiService>(
  "@stacksindex/utils/StacksApiService",
);
