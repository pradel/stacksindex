# ALEX DEX Pool Indexer Example (Effect)

The same ALEX DEX pool indexer as [`examples/dex-alex`](../dex-alex), written with the Effect-based `stacksindex/effect` API.

## Features Demonstrated

- **Indexer Definition**: `src/indexer.ts` defines the `pool` contract with `defineIndexer`; `src/handler.ts` types its handler with `indexer.handler("pool", ...)`, returning an `Effect`.
- **Effect Schema**: The contract's `print` schema decodes each print into a typed `event.data`. Prints the indexer does not handle are skipped with `onInvalid: "skip"`.
- **Atomic Writes**: Handlers write through `yield* indexer.Db`, the batch transaction in the same database as the indexer, so each batch of writes commits with the indexer checkpoint. `migrations: "./drizzle"` applies the app's migrations to `public`.
- **Typed Relational Queries**: `relations` passed to `defineIndexer` types `indexer.Db`'s `db.query`.
- **Pinned Read-Only Calls**: `yield* indexer.Client` calls contracts at the handled event's block.
- **Graceful Shutdown**: The run fiber is interrupted on `SIGINT` / `SIGTERM` so scopes finalize.

## Running the Example

1. **Install dependencies**:

   ```bash
   pnpm install
   ```

2. **Start indexing** (migrations are applied on startup):

   ```bash
   pnpm dev
   ```

   Add `--live` to keep following new blocks after the historical sync (`pnpm dev --live`). Set `STACKS_TRANSPORT=websocket` to detect them over the API websocket instead of polling. Set `HIRO_API_KEY` to raise the API rate limit.

3. **Inspect indexed data with Drizzle Studio** (stop the indexer first: PGlite allows one process per database):
   ```bash
   pnpm studio
   ```
