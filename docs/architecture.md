# Stacks Blockchain Indexer Architecture

A blockchain indexer fetches raw data from a Stacks node, caches it locally, and transforms it into queryable tables through user-defined handlers.

This architecture assumes a single Stacks network per indexer instance.

## Architecture Overview

```
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

- Fetch events using cursor-based pagination
- Fetch transactions and blocks for event context
- Track sync progress with cursors and block heights
- Handle historical backfill and realtime updates

### Sync Store

PostgreSQL tables that cache raw blockchain data. This avoids re-fetching data on restarts and enables efficient queries during indexing.

### Indexer

Processes events from the sync store by executing user-defined handlers. Each handler receives decoded event data and can write to user tables.

### User Tables

PostgreSQL tables defined by the user's schema. These store the transformed/indexed data that applications query.

## Configuration

Users configure the indexer with four elements:

```
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

Define the Stacks network to connect to:

- API endpoint URL (e.g., `https://api.hiro.so`)
- Polling interval for new blocks

### Contracts

Define what events to capture:

- Contract ID(s) (e.g., `SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles`)
- Event types to filter (e.g., `smart_contract_log`)
- Block range (start/end)

### Schema

Define output tables using standard SQL types:

- Table names and columns
- Primary keys
- Indexes

### Handlers

Define transformation logic:

- One function per event type
- Receives decoded event data
- Writes to user tables via database API

## Stacks Event Structure

Events from the Stacks API have this structure:

```
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

```
1. SYNC PHASE (Historical)

   ┌──────────────────────────────────────────────────────────┐
   │  Fetch events for contract (cursor-based pagination)     │
   │  GET /extended/v2/smart-contracts/{contract_id}/logs   │
   │      ?limit=50                                          │
   └────────────────────────┬─────────────────────────────────┘
                             │
                             ▼
   ┌──────────────────────────────────────────────────────────┐
   │  For each event:                                         │
   │  - Extract tx_id                                         │
   │  - Fetch transaction: GET /extended/v1/tx/{tx_id}        │
   │  - Extract block_hash from transaction (reorg-proof)      │
   │  - Fetch block: GET /extended/v2/blocks/{block_hash}     │
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

```
block_height:microblock_sequence:tx_index:event_index
```

Example: `100:0:5:2` means block height 100, microblock sequence 0, transaction index 5, event index 2.

This cursor format is opaque and passed directly to subsequent API requests to paginate through historical events.

## Sync Modes

### Historical Sync

Fetches past blockchain data using cursor-based pagination, from oldest to newest.

```
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

### Realtime Sync

Polls for new blocks after historical sync completes, then fetches events for new blocks.

```
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

Defines what blockchain data to fetch:

```
Filter {
    contract_id: string              -- e.g., "SP6P4EJF...satoshibles"
    event_types: string[] | null     -- Filter locally: ["smart_contract_log"]
    start_block: number              -- Default: 0
    end_block: number | null         -- null = ongoing (realtime)
}
```

### Event (Decoded)

Event passed to handlers after decoding:

```
Event {
    -- Raw event data
    event_index: number
    event_type: string
    tx_id: string
    contract_id: string
    topic: string
    value_hex: string
    value_repr: string

    -- Decoded Clarity value (parsed from repr or hex)
    args: object

    -- Context (from transaction)
    block_height: number
    block_time: number
    tx_index: number
    sender_address: string
}
```

### Checkpoint

Tracks indexing progress:

```
Checkpoint {
    block_height: number             -- Last fully processed block
    block_time: number
}
```

## Crash Recovery

On startup, the indexer:

1. Reads the `_checkpoint` table to find the last processed block
2. Reads `sync_progress` to find the last cursor for each contract
3. Resumes syncing from the saved cursor
4. Resumes indexing from the checkpoint block

```
┌─────────────────────────────────────────────────────────┐
│                     ON STARTUP                          │
├─────────────────────────────────────────────────────────┤
│  1. Read _checkpoint table                              │
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

| Component  | Purpose                          | Storage            |
| ---------- | -------------------------------- | ------------------ |
| Syncer     | Fetch events, txs, blocks        | sync\_\* tables    |
| Sync Store | Cache raw Stacks data            | PostgreSQL         |
| Indexer    | Execute handlers, transform data | user tables        |
| Checkpoint | Track progress, enable recovery  | \_checkpoint table |
