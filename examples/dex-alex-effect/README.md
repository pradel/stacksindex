# ALEX DEX Pool Indexer Example (Effect)

The same ALEX DEX pool indexer as [`examples/dex-alex`](../dex-alex), written with the Effect-based `stacksindex` API.

## Features Demonstrated

- **Effect Handlers**: Handlers return `Effect` and compose with `Effect.gen`.
- **Effect Schema**: Contract logs are validated with `Schema` instead of Zod.
- **Effect Resource Management**: Databases are opened with `makeDatabase` and closed through the `Scope` of the run.
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

3. **Inspect indexed data with Drizzle Studio**:
   ```bash
   pnpm studio
   ```
