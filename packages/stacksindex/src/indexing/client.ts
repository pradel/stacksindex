import { Context, Effect } from "effect";

import type { IndexingClient } from "../lib/types.ts";

/**
 * Read-only contract client pinned to the block of the event being handled.
 * Provided by the runtime around every handler call.
 */
export class HandlerClient extends Context.Service<HandlerClient, IndexingClient>()(
  "stacksindex/indexing/HandlerClient",
  {
    make: Effect.die("HandlerClient is only available inside an event handler"),
  },
) {}
