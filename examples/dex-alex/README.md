# ALEX DEX Pool Indexer Example

An end-to-end example demonstrating how to index ALEX DEX pool events using the promise-based `stacksindex` API and Zod. See [`examples/dex-alex-effect`](../dex-alex-effect) for the same indexer written with the Effect API.

## Features Demonstrated

- **Indexer Definition**: `src/indexer.ts` defines the `pool` contract with `defineIndexer`; `src/handler.ts` types its handler with `indexer.handler("pool", ...)`.
- **Zod Print Schema**: The contract's `print` schema parses each print into a typed `event.data`. Prints the indexer does not handle are skipped with `onInvalid: "skip"`.
- **Typed Read-Only Calls**: Uses Clarity ABIs to fetch pool tokens and decimals at the exact event block.
- **Atomic Writes**: Handlers write the `pool`, `swap` and `token` tables through `db`, in the same PGlite database as the indexer, so each batch of writes commits with the indexer checkpoint. `migrations: "./drizzle"` applies the app's migrations to `public`.
- **Typed Relational Queries**: `relations` passed to `defineIndexer` types `db.query`.

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

   Set `OTEL_EXPORTER_OTLP_ENDPOINT` to push the indexer's metrics over OTLP, e.g. `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm dev --live` for an OpenTelemetry Collector, or `http://localhost:9090/api/v1/otlp` for Prometheus started with `--web.enable-otlp-receiver`.

3. **Inspect indexed data with Drizzle Studio** (stop the indexer first: PGlite allows one process per database):
   ```bash
   pnpm studio
   ```
