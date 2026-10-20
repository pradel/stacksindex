# ALEX DEX Pool Indexer Example (Effect)

The same ALEX DEX pool indexer as [`examples/dex-alex`](../dex-alex), written with the Effect-based `stacksindex` API.

## Features Demonstrated

- **Effect Handlers**: Handlers return `Effect` and compose with `Effect.gen`.
- **Effect Schema**: Contract logs are validated with `Schema` instead of Zod.
- **Atomic Writes**: Handlers write through `context.db`, in the same database as the indexer, so each batch of writes commits with the indexer checkpoint. `migrate` applies the app's migrations to `public`.
- **Graceful Shutdown**: The run fiber is interrupted on `SIGINT` / `SIGTERM` so scopes finalize.

## Running the Example

1. **Install dependencies**:

   ```bash
   pnpm install
   ```

2. **Run migrations & start indexing**:

   ```bash
   pnpm dev
   ```

   Add `--live` to keep following new blocks after the historical sync (`pnpm dev --live`). Set `STACKS_TRANSPORT=websocket` to detect them over the API websocket instead of polling.

3. **Inspect indexed data with Drizzle Studio** (stop the indexer first: PGlite allows one process per database):
   ```bash
   pnpm studio
   ```
