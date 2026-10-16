# ALEX DEX Pool Indexer Example

An end-to-end example demonstrating how to index ALEX DEX pool events using the promise-based `stacksindex` API and Zod. See [`examples/dex-alex-effect`](../dex-alex-effect) for the same indexer written with the Effect API.

## Features Demonstrated

- **Historical Event Sync**: Indexes pool creation, swaps, and liquidity changes.
- **Typed Read-Only Calls**: Uses Clarity ABIs to fetch pool tokens and decimals at the exact event block height.
- **Relational Storage**: Stores derived data in PGlite tables (`pool`, `swap`, `token`) using Drizzle ORM.
- **Zod Validation**: Parses decoded contract logs with Zod schemas.

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
