# ALEX DEX Pool Indexer Example

An end-to-end example demonstrating how to index ALEX DEX pool events using `stacksindex`.

## Features Demonstrated

- **Historical Event Sync**: Indexes pool creation, swaps, and liquidity changes.
- **Typed Read-Only Calls**: Uses Clarity ABIs to fetch pool tokens and decimals at the exact event block height.
- **Relational Storage**: Stores derived data in PGlite tables (`pool`, `swap`, `token`) using Drizzle ORM.

## Running the Example

1. **Install dependencies**:

   ```bash
   pnpm install
   ```

2. **Run migrations & start indexing**:

   ```bash
   pnpm dev
   ```

3. **Inspect indexed data with Drizzle Studio**:
   ```bash
   pnpm studio
   ```
