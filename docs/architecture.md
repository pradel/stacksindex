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

PostgreSQL / PGlite tables that cache raw blockchain data. This avoids re-fetching data on restarts and enables efficient queries during indexing.

### Indexer

Processes events from the sync store by executing user-defined handlers. Each handler receives event data and a context containing the database client and a read-only contract client.

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
│  Filters        │  Contract IDs, block ranges               │
├─────────────────┼───────────────────────────────────────────┤
│  Schema         │  Output table definitions                 │
├─────────────────┼───────────────────────────────────────────┤
│  Handlers       │  Event processing functions               │
└─────────────────┴───────────────────────────────────────────┘
```

### Network

Define the Stacks network to connect to:

- API endpoint URL (e.g., `https://api.hiro.so`)
- Optional API key (`apiKey`)
- Polling interval for new blocks

### Filters

Define what contract events to capture and their handlers:

- Contract ID (e.g., `SP6P4EJF0VG8V0RB3TQQKJBHDQKEF6NVRD1KZE3C.satoshibles`)
- Handler function associated with the contract
- Block range (start/end)

### Schema

Define output tables using standard SQL types:

- Table names and columns
- Primary keys
- Indexes and constraints

### Handlers

Define transformation logic:

- One handler function per contract
- Receives the raw event (`HandlerEvent`)
- Receives `HandlerContext` with:
  - `db`: Database instance to write to user tables
  - `client`: Provides `callReadOnly(contractId, functionName, options)` with automatic block pinning (`tip: event.block_height`) for time-travel contract state lookups

## Stacks Event Structure

Events from the Stacks API have this structure:

```
Event {
    event_index: number
    event_type: string                  -- "smart_contract_log", "stx_transfer", etc.
    tx_id: string                       -- Transaction ID
    contract_log: {
        contract_id: string             -- e.g., "SP6P4EJF...satoshibles"
        topic: string                   -- e.g., "print"
        value: {
            hex: string                 -- Raw Clarity hex (e.g. "0x0100000000000000000000000000000001")
            repr: string                -- Human-readable representation: "(tuple (action \"mint\") (id u1))"
        }
    }
}
```

Key differences from EVM:

- No topics array (topic0-3) - instead has `topic` field (usually "print")
- Event data is a Clarity value (hex + repr) not raw ABI-encoded bytes
- Events are linked to transactions via `tx_id`, not directly to blocks
- Filtering by contract only - event type filtering done locally

## Data Flow

```
1. SYNC PHASE (Historical)

   Step A: Initial Cursor Discovery (Genesis Bootstrap)
   ┌──────────────────────────────────────────────────────────┐
   │ 1. GET /extended/v1/contract/{contract_id}               │
   │    -> Get deployment block height                        │
   │ 2. GET /extended/v3/principals/{principal}/transactions  │
   │    ?cursor={startBlock}:0:0                              │
   │ 3. GET /extended/v3/transactions/{tx_id}/events          │
   │    -> Find first matching smart_contract_log             │
   │ 4. Construct 4-part cursor                               │
   │    (block_height:microblock_sequence:tx_index:event_index│
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   Step B: Event Ingestion & Cache
   ┌──────────────────────────────────────────────────────────┐
   │ Fetch events with cursor:                                │
   │ GET /extended/v2/smart-contracts/{contract_id}/logs      │
   │     ?cursor={cursor}&limit=100                           │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │ For each batch:                                          │
   │ - Batch fetch missing txs: GET /extended/v3/transactions/│
   │ - Batch fetch missing blocks: GET /extended/v2/blocks/   │
   │ Store in sync store: events, transactions, blocks        │
   │ Update cursor in sync_progress                           │
   └────────────────────────┬─────────────────────────────────┘
                            │
2. INDEX PHASE              ▼

   ┌──────────────────────────────────────────────────────────┐
   │ Query events from sync store (events joined with tx & blk│
   │ Order by block_height, tx_index, event_index             │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Pass HandlerEvent + HandlerContext { db, client }        │
   │ Execute handler function                                 │
   │ Handler writes to user tables                            │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │ Update checkpoints table                                 │
   └──────────────────────────────────────────────────────────┘
```

### Pagination Cursor

The Stacks API v2 uses a cursor with the structure:

```
block_height:microblock_sequence:tx_index:event_index
```

Example: `100:0:5:2` means block height 100, microblock sequence 0, transaction index 5, event index 2.

#### Why Cursor Discovery is Required

The Stacks `/extended/v2/smart-contracts/{contract_id}/logs` endpoint strictly validates that the supplied cursor corresponds to an actual, existing contract log event on-chain. Supplying an arbitrary or synthesized cursor (such as `0:0:0:0` or `${startBlock}:0:0:0`) returns `404 Not Found (Cursor not found)`.

To resolve the initial cursor:

1. Fetch contract metadata via `GET /extended/v1/contract/{contract_id}` to obtain its deployment `block_height`.
2. Jump straight to the deployment or requested `startBlock` using `GET /extended/v3/principals/{principal}/transactions?cursor=${startBlock}:0:0`.
3. Scan transactions in chronological order and query `GET /extended/v3/transactions/{tx_id}/events` to locate the first `smart_contract_log` for that contract.
4. Construct the exact 4-part cursor (`block_height:0:tx_index:event_index`) to begin forward pagination with `/logs`.

## Sync Modes

### Historical Sync

Fetches past blockchain data using cursor-based pagination, from oldest to newest.

```
Start Block ──────────────────────────────────▶ End Block / Latest
             [page 1] → [page 2] → [page 3] → ...
                            │
                       (next cursor)

- Discover initial cursor at startBlock / deployment block
- Use "next_cursor" from response to paginate forward through history
- For each page of events:
  - Batch fetch transactions (deduplicated by tx_id)
  - Batch fetch blocks by hash (deduplicated, reorg-proof)
- Store everything in sync store
- Save cursor to sync_progress to enable resume after restart
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

```typescript
Filter {
    contractId: string               // e.g., "SP6P4EJF...satoshibles"
    handler: EventHandler            // Handler function for this contract
    startBlock?: number              // Optional start block height
    endBlock?: number | "latest"     // Optional end block height or "latest"
}
```

### HandlerEvent

Event passed to contract handlers:

```typescript
HandlerEvent {
    // Raw event data
    event_index: number
    event_type: string
    tx_id: string
    contract_log: {
        contract_id: string
        topic: string
        value: {
            hex: string              // Raw Clarity value hex (decoded in handler)
            repr: string             // Human-readable string repr
        }
    }

    // Context (from transaction and block)
    block_height: number
    block_time: number
    tx_index: number
    sender_address: string
}
```

### HandlerContext

Context passed to handler execution:

```typescript
HandlerContext<TSchema> {
    db: NodePgDatabase<TSchema> | PgliteDatabase<TSchema>   // Database instance
    client: {
        callReadOnly: (contractId, functionName, options?) => Promise<Result<CallReadResponse, StacksApiError>>
        // Automatically pinned to the event's historical block (tip: event.block_height)
    }
}
```

### Checkpoint

Tracks indexing progress:

```typescript
Checkpoint {
    chainId: bigint                  // Chain ID
    blockHeight: bigint              // Last fully processed block height
    blockTime: bigint
}
```

## Crash Recovery

On startup, the indexer:

1. Reads the `checkpoints` table to find the last processed block
2. Reads `sync_progress` to find the last cursor and status for each contract
3. Resumes syncing from the saved cursor (or resolves the next cursor via discovery if unindexed events remain)
4. Resumes indexing from the checkpoint block

```
┌─────────────────────────────────────────────────────────┐
│                     ON STARTUP                          │
├─────────────────────────────────────────────────────────┤
│  1. Read checkpoints table                              │
│     └─▶ last_block = 1000                               │
│                                                         │
│  2. Read sync_progress table                            │
│     └─▶ contract SP6P4...: cursor = "1500:0:5:2"        │
│         last_block_height = 1500                        │
│                                                         │
│  3. Resume sync from cursor "1500:0:5:2"                │
│     (continue paginating where we left off)             │
│                                                         │
│  4. Resume indexing from block 1001                     │
│     (events 1001-1500 already in sync store)            │
│ └─────────────────────────────────────────────────────────┘
```

## Summary

| Component  | Purpose                          | Storage / Tech                     |
| ---------- | -------------------------------- | ---------------------------------- |
| Syncer     | Fetch events, txs, blocks        | `events`, `transactions`, `blocks` |
| Sync Store | Cache raw Stacks data            | PostgreSQL / PGlite                |
| Indexer    | Execute handlers, transform data | user tables                        |
| Checkpoint | Track progress, enable recovery  | `checkpoints`, `sync_progress`     |
