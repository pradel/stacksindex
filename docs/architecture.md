# Stacks Blockchain Indexer Architecture

A blockchain indexer fetches raw data from the Stacks API, caches it locally, and transforms it into queryable tables through user-defined handlers.

This architecture assumes a single Stacks network per indexer instance. The current POC implements historical sync only; realtime tailing and a read API are future work.

## Architecture Overview

```text
┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│    Stacks    │────▶│    Syncer    │────▶│   Indexer    │────▶│     API      │
│     API      │     │              │     │              │     │   (read)     │
└──────────────┘     └──────┬───────┘     └──────┬───────┘     └──────────────┘
                            │                    │
                            ▼                    ▼
                     ┌──────────────┐     ┌──────────────┐
                     │  Sync Store  │     │ User Tables  │
                     │   (cache)    │     │  (indexed)   │
                     └──────────────┘     └──────────────┘
```

## Components

### Syncer

Fetches raw blockchain data from the Stacks API and stores it in the sync store.

Responsibilities:

- Fetch `smart_contract_log` events using cursor-based pagination
- Batch-fetch transactions (`/extended/v1/tx/multiple`) and blocks for context
- Track sync progress with cursors and block heights
- Handle historical backfill (realtime updates are future work)

### Sync Store

PostgreSQL tables that cache raw blockchain data. This avoids re-fetching data on restarts and enables efficient queries during indexing.

### Indexer

Processes events from the sync store by executing user-defined handlers. Each handler receives decoded event data and can write to user tables.

### User Tables

PostgreSQL tables defined by the user's schema. These store the transformed/indexed data that applications query.

## Configuration

Users configure the indexer with four elements:

```text
┌─────────────────────────────────────────────────────────────┐
│                      CONFIGURATION                          │
├─────────────────┬───────────────────────────────────────────┤
│  Network        │  Stacks API endpoint and settings         │
├─────────────────┼───────────────────────────────────────────┤
│  Contracts      │  Contract IDs to index                    │
├─────────────────┼───────────────────────────────────────────┤
│  Schema         │  Output table definitions                 │
├─────────────────┼───────────────────────────────────────────┤
│  Handlers       │  Event processing functions               │
└─────────────────┴───────────────────────────────────────────┘
```

### Network

Configured on the runtime via `network`:

- `"mainnet"` / `"testnet"` presets, or `{ url, chainId? }` for custom endpoints
- Optional `apiKey`, sent as the `x-api-key` header

### Contracts

Defined as filters on `runtime.run([...])`:

- `contractId` (e.g., `SP….fixed-weight-pool-v1-01`)
- Optional block range: `startBlock` (skip older events when processing) and
  `endBlock` (stop syncing/processing at this height, inclusive)
- Only `smart_contract_log` events are persisted in the POC

### Schema

Define output tables using standard SQL types:

- Table names and columns
- Primary keys
- Indexes

### Handlers

One handler per contract filter. Each receives:

- `event` — raw log fields plus `decoded` (the parsed Clarity value) and sync
  metadata (`block_height`, `block_time`, `tx_index`, `sender_address`)
- `context.db` — database handle for derived writes
- `context.client` — read-only contract calls against the configured network,
  pinned to the chain tip of the block being processed (`?tip=` on
  `/v2/contracts/call-read`) so reads stay deterministic across runs

## Stacks Event Structure

Events from the Stacks API have this structure:

```text
Event {
    event_index: number
    event_type: string              -- "smart_contract_log", "stx_transfer", etc.
    tx_id: string                   -- Transaction ID
    contract_id: string             -- e.g., "SP6P4EJF...satoshibles"
    topic: string                   -- e.g., "print"
    value: {
        hex: string                  -- Raw Clarity value
        repr: string                 -- Human-readable: "(tuple (action \"mint\") (id u1))"
    }
}
```

Key differences from EVM:

- No topics array (topic0-3) - instead has `topic` field (usually "print")
- Event data is a Clarity value (hex + repr) not raw bytes
- Events are linked to transactions via `tx_id`, not directly to blocks
- Filtering by contract only - event type filtering done locally

## Data Flow

```text
1. SYNC PHASE (Historical)

   ┌──────────────────────────────────────────────────────────┐
   │  Fetch events for contract (cursor-based pagination)     │
   │  GET /extended/v2/smart-contracts/{contract_id}/logs   │
   │      ?limit=50                                          │
   └────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Deduplicate tx_ids, then batch fetch missing txs        │
   │  GET /extended/v1/tx/multiple?tx_id=…&tx_id=…            │
   │  Deduplicate block hashes, then batch fetch missing      │
   │  blocks: GET /extended/v2/blocks/{block_hash}            │
   └────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Store in sync cache:                                    │
   │  - sync_events                                           │
   │  - sync_transactions                                     │
   │  - sync_blocks                                           │
   │  Update cursor in sync_progress                          │
   └────────────────────────┬─────────────────────────────────┘
                            │
2. INDEX PHASE              ▼

   ┌──────────────────────────────────────────────────────────┐
   │  Query events from sync store                            │
   │  Order by block_height, tx_index, event_index            │
   │  Filter by event_type locally                            │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Decode Clarity value                                    │
   │  Execute handler function                                │
   │  Write to user tables                                    │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │  Update checkpoint                                       │
   └──────────────────────────────────────────────────────────┘
```

### Pagination Cursor

The Stacks API v2 uses a cursor with the structure:

```text
block_height:microblock_sequence:tx_index:event_index
```

Example: `100:0:5:2` means block height 100, microblock sequence 0, transaction index 5, event index 2.

This cursor format is opaque and passed directly to subsequent API requests to paginate through historical events.

Note: first-cursor discovery walks `/extended/v1/address/{contract}/transactions`
backwards, which can time out on very large contracts. Operators can seed a
resume cursor directly via `syncStore.upsertSyncProgress` to start from a known
position instead.

## Sync Modes

### Historical Sync

Fetches past blockchain data using cursor-based pagination, from oldest to newest.

```text
Block 0 ──────────────────────────────────────▶ Latest Block
         [page 1] → [page 2] → [page 3] → ...
                        │
                   (next cursor)

- Query events for contract starting from beginning
- Use "next_cursor" from response to paginate forward through history
- For each page of events:
  - Batch fetch transactions (deduplicated by tx_id)
  - Batch fetch blocks by hash (deduplicated, reorg-proof)
- Store everything in sync cache
- Save cursor to enable resume after restart
```

### Realtime Sync (planned)

Not implemented in the POC. The plan: poll for new blocks after historical sync
completes, then fetch events for new blocks.

```text
              poll         poll         poll
               │            │            │
               ▼            ▼            ▼
... ────[block N]────[block N+1]────[block N+2]────▶

1. Poll for latest block height
2. If new blocks exist since last sync:
   - Fetch events for each new block
   - Fetch transactions for those events
   - Store in sync cache
   - Process through indexer
3. Update checkpoint
4. Wait for polling interval
5. Repeat
```

## Key Data Structures

### Filter

Defines what blockchain data to fetch and process:

```text
Filter {
    contractId: string               -- e.g., "SP6P4EJF...satoshibles"
    handler: EventHandler            -- async (event, context) => void
    startBlock?: number              -- skip events below this height
    endBlock?: number                -- inclusive upper bound on processing
}
```

Only `smart_contract_log` events are stored in the POC. `endBlock` bounds
processing only: rows above it may still be fetched and retained in the sync
store, but they are never dispatched to handlers. Bounds are enforced at
dispatch time, so out-of-range rows can exist in the sync store without ever
reaching handlers.

### Event (Decoded)

Event passed to handlers after decoding:

```text
HandlerEvent {
    -- Raw log data (from the Stacks API)
    event_index: number
    event_type: string               -- always "smart_contract_log"
    tx_id: string
    contract_log: { contract_id, topic, value: { hex, repr } }

    -- Decoded Clarity value (undefined when decoding fails)
    decoded: ClarityValue | undefined

    -- Context (enriched from transaction + block)
    block_height: number
    block_time: number
    tx_index: number
    sender_address: string
}
```

### Checkpoint

Tracks indexing progress:

```text
Checkpoint {
    block_height: number             -- Last fully processed block
    block_time: number
}
```

## Crash Recovery

On startup, the indexer:

1. Reads the `checkpoints` table to find the last processed block
2. Reads `sync_progress` to find the last cursor for each contract
3. Resumes syncing from the saved cursor
4. Resumes indexing from the checkpoint block

```text
┌─────────────────────────────────────────────────────────┐
│                     ON STARTUP                          │
├─────────────────────────────────────────────────────────┤
│  1. Read checkpoints table                              │
│     └─▶ last_block = 1000                               │
│                                                         │
│  2. Read sync_progress table                            │
│     └─▶ contract SP6P4...: cursor = "abc123"            │
│         last_block_height = 1500                        │
│                                                         │
│  3. Resume sync from cursor "abc123"                    │
│     (continue paginating where we left off)             │
│                                                         │
│  4. Resume indexing from block 1001                     │
│     (events 1001-1500 already in sync store)            │
└─────────────────────────────────────────────────────────┘
```

## Summary

| Component  | Purpose                          | Storage           |
| ---------- | -------------------------------- | ----------------- |
| Syncer     | Fetch events, txs, blocks        | sync\_\* tables   |
| Sync Store | Cache raw Stacks data            | PostgreSQL        |
| Indexer    | Execute handlers, transform data | user tables       |
| Checkpoint | Track progress, enable recovery  | checkpoints table |
