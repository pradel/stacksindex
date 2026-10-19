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
- How live sync detects new blocks: `live.transport` (`"polling"` or `"websocket"`), `live.pollingInterval`, `live.webSocketUrl`

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
  - `client`: Provides `callReadOnly(options)` pinned to the event's block for time-travel contract state lookups (supports both typed with `abi` and untyped calls). The node pins reads by index block hash, so heights are resolved through `GET /extended/v2/blocks/{height}`, once per height per indexing batch

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
   │ 1. GET /extended/v3/smart-contracts/{contract_id}        │
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
   Step B: Event Ingestion & Cache (backfill)
   ┌──────────────────────────────────────────────────────────┐
   │ Fetch events with cursor:                                │
   │ GET /extended/v2/smart-contracts/{contract_id}/logs      │
   │     ?cursor={cursor}&limit=100                           │
   │ Follow next_cursor until it is null                      │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   Step C: Catch-up from the newest events
   ┌──────────────────────────────────────────────────────────┐
   │ GET /extended/v2/smart-contracts/{contract_id}/logs      │
   │     ?limit=100            (no cursor = newest page)      │
   │ Follow prev_cursor back to syncedBlockHeight             │
   │ Nothing newer than syncedBlockHeight: done (1 request)   │
   └────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
   ┌──────────────────────────────────────────────────────────┐
   │ For each page (oldest first):                            │
   │ - Batch fetch missing txs: GET /extended/v3/transactions/│
   │   batch (up to 20 tx_ids per request)                    │
   │ - Extract missing blocks from transactions in memory     │
   │ Store in sync store: events, transactions, blocks        │
   │ Update cursor and syncedBlockHeight in sync_progress     │
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

The logs endpoint returns events newest first, limited to the canonical chain. A `cursor` selects the events at or below it. In the response:

- `cursor` is the newest event on the page.
- `next_cursor` is the event one full page newer. It is `null` whenever fewer than `limit` newer events exist, so following `next_cursor` alone never reaches the newest events.
- `prev_cursor` is the newest event of the next older page.

#### Why Cursor Discovery is Required

Because a cursor selects events at or below it, paging forward from `startBlock` requires the cursor of the first event at or above it. Synthesized cursors such as `${startBlock}:0:0:0` select older events instead, and older API versions reject cursors that do not match an existing event.

To resolve the initial cursor:

1. Fetch contract metadata via `GET /extended/v3/smart-contracts/{contract_id}` to obtain its deployment `block.height`.
2. Jump straight to the deployment or requested `startBlock` using `GET /extended/v3/principals/{principal}/transactions?cursor=${startBlock}:0:0`.
3. Scan transactions in chronological order and query `GET /extended/v3/transactions/{tx_id}/events` to locate the first `smart_contract_log` for that contract.
4. Construct the exact 4-part cursor (`block_height:0:tx_index:event_index`) to begin forward pagination with `/logs`.

Discovery runs only for a contract's first sync, and as a fallback when a catch-up backlog exceeds 10 pages.

## Sync Modes

### Historical Sync

Backfills past blockchain data using cursor-based pagination, from oldest to newest, then catches up from the newest events.

```
Start Block ──────────────────────────────────▶ Latest
             [page 1] → [page 2] → ... → [last full page]   [head] ← [older] ← ...
                            │                                  │
                       (next cursor)                     (prev cursor)

- Discover initial cursor at startBlock / deployment block
- Use "next_cursor" from response to paginate forward through history
- When "next_cursor" is null, fetch the newest page and follow "prev_cursor"
  back to syncedBlockHeight, then store those pages oldest first
- For each page of events:
  - Batch fetch transactions (deduplicated by tx_id)
  - Extract blocks by hash from transaction payloads in memory
- Store everything in sync store
- Save cursor and syncedBlockHeight to sync_progress to enable resume after restart
```

`sync_progress.syncedBlockHeight` guarantees every event of the contract at or below it is stored. A run for a caught-up contract fetches only the newest page; when its newest event is at or below `syncedBlockHeight`, the contract is up to date after a single request. A contract that finished on its newest page, read after the tip, has all its events up to the tip stored, so the pass raises its `syncedBlockHeight` to the tip. A contract whose first-event discovery found nothing keeps its height and is caught up by the next pass, since discovery only sees transactions involving the contract's principal.

Indexing within a run is capped at the chain tip read before syncing starts. Contracts are checked one after another, so events above that tip may still be missing for contracts checked earlier; they are indexed by the next run, which keeps handler order chronological.

### Live Sync

`live` runs a historical pass, then follows new chain heads (`runtime/realtime.ts`), after Ponder's realtime sync.

```mermaid
flowchart TD
  H[head from BlockHeads<br/>polling or websocket] --> D[repeated hashes dropped<br/>only the newest head kept]
  D --> S{head is the anchor<br/>or below it?}
  S -- yes --> H
  S -- no --> P{blocks link the head to the anchor<br/>and cost fewer requests than<br/>one logs page per contract?}
  P -- yes --> B[per block: block transactions<br/>then each transaction's events]
  P -- no --> C[per contract: newest logs pages<br/>after verifying the anchor]
  B --> I[anchor = head, index up to head]
  C --> I
  I --> E{every filter past its endBlock?}
  E -- no --> H
  E -- yes --> X[done]
```

**Heads** (`datasources/api/heads.ts`). `"polling"` reads `GET /extended/v2/blocks?limit=1` every `pollingInterval` (default 5s; Stacks blocks arrive every ~10s and unauthenticated Hiro clients get 50 requests per minute). `"websocket"` subscribes to `block` notifications on `/extended/v1/ws` (JSON-RPC), polls once per connection to catch heads missed while disconnected, reconnects after `125 * 2^n` ms and switches to polling for good after 9 consecutive failures. Both warn when no new head arrived for 30s.

**One pass per head.** Heads that arrive while a pass runs collapse to the newest, because each pass covers the whole range since the anchor. A head older than the anchor (a lagging API replica) is skipped: lowering the anchor would replay indexed blocks.

**Fetch path.** Ponder fetches every block with one `eth_getLogs` filtered by address. The Stacks API has no per-block filtered events endpoint: block transaction summaries carry no events, and a contract's print events may come from transactions calling other contracts. So each head picks the cheaper of:

- **Per block** (`sync-realtime/block.ts`): for every block between the anchor and the head, `GET /extended/v3/blocks/{hash}/transactions` (50 per page), then `GET /extended/v3/transactions/{tx_id}/events` (100 per page) for each successful transaction, keeping the watched contracts' logs. Cost ≈ `Σ (1 + tx_count)`. Requires the blocks to link the head to the anchor (`GET /extended/v2/blocks`, at most 30) and every syncing contract synced through the anchor.
- **Per contract**: the historical catch-up, one newest logs page per syncing contract.

Both store the same rows, and the per-block path raises every syncing contract's `syncedBlockHeight` with each block.

**Reorgs.** A head built on the anchor (or blocks linking it) proves the anchor canonical without a request. Otherwise the anchor check of `reconcileWithCanonicalChain` runs, and a reorged range is rewound and replayed like at the start of a run.

**Errors.** A failed pass is retried with the next head. `live` fails once 10 consecutive passes failed over at least 10 minutes (Ponder's realtime budget), and at once on handler, database, cursor or finalized-reorg errors.

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
HandlerContext {
    db: IndexerDb                 // Transaction-scoped database handle
    client: {
        callReadOnly: (options) => Effect<Result<...>>
        // Supports typed calls (with abi) and untyped calls (with raw args), pinned to the index block hash of the event's block
    }
    decode: (schema, repr) => Effect<...>
}
```

The core handler contract is Effect-only. The promise entrypoint (`stacksindex`) is an adapter that exposes the same context with `client.callReadOnly` returning a `Promise`, plus a `logger` bound to the configured Effect logger. The Effect entrypoint (`stacksindex/effect`) exposes the raw services, layers, and clients.

### Entrypoints

- `stacksindex` — promise-native facade: `createIndexer({ database, network, api, finality, live, logLevel, telemetry })` owns the database and runtime lifecycle and returns `{ db, migrate, run, live, status, close, [Symbol.asyncDispose] }`. `run` returns a `RunResult` summary; `live` resolves when every filter reached its `endBlock` or on `close()`; `status()` returns an `IndexerStatus`; `close()` flushes the metrics exporter.
- `stacksindex/effect` — Effect-native surface: `Indexer` (+ `layer` and `layerWithDatabase`), `IndexerDatabase`, `Indexing`, `StacksClient`, `readOnly`, `makeDatabase`, `migrate`, and `loggerLayer`.

### Services

The runtime is composed from Effect services and layers:

- `IndexerDatabase` — the Drizzle database; `IndexerDatabase.transaction(f)` re-provides the transaction handle as the service.
- `Indexer` — `Indexer.layer({ network, api, finality, live })` builds the Stacks API client and the in-memory `RunPhase`; `run(filters)` and `live(filters)` require `IndexerDatabase`. Both set the phase (`backfill`, then `done`, `failed`, or `idle` when interrupted; `runLive` sets `live` once it follows new heads) and add the `chain_id` attribute to every metric recorded inside through `Metric.CurrentMetricAttributes`. `status` combines the phase with the stored checkpoint, sync anchor and per-contract sync progress. `Indexer.layerWithDatabase({ database, network, api, finality, live, logLevel, telemetry })` provides the indexer, database, logger and, with `telemetry.otlp`, the metrics exporter in one layer.
- `Indexing` — `Indexing.layer({ handlers })` executes user handlers inside `IndexerDatabase.transaction` (internal).
- `loggerLayer({ level })` — installs Effect's pretty console logger and minimum log level.
- `telemetryLayer(telemetry)` — `OtlpMetrics.layer` over the fetch HTTP client with protobuf serialization, posting to `${baseUrl}/v1/metrics` (internal). Metrics are defined once in `lib/metrics.ts` and recorded in Effect's default `MetricRegistry`; nothing is served over HTTP. Closing the layer flushes the last snapshot.

### Checkpoint

Tracks indexing progress:

```typescript
Checkpoint {
    chainId: bigint                  // Chain ID
    blockHeight: bigint              // Last fully processed block height
    blockTime: bigint
    finalizedBlockHeight: bigint     // Highest block that is final
    finalizedBlockTime: bigint
}
```

`finalizedBlockHeight` trails `blockHeight` by the configured `finality`
(confirmations). Blocks above it are provisional and may be reorged.

### Sync Anchor

`sync_anchors` holds the chain tip (height and hash) read at the start of the
latest pass: a run, or a new head in live sync. Indexing in that pass is
capped at the anchor, so nothing above it was indexed. When the anchor's block
is still canonical at the next pass, every stored block below it is canonical
too, because a canonical block's ancestors are canonical.

## Crash Recovery

On startup, the indexer:

1. Reads the chain tip
2. Verifies the previous anchor against the canonical chain and discards stored
   data that may belong to an orphaned fork (see Reorgs)
3. Saves the chain tip as the new anchor
4. Reads `sync_progress` for each contract
5. Resumes backfilling from the saved cursor, or catches up from the newest
   events down to `syncedBlockHeight`
6. Resumes indexing from the checkpoint block

### Reorgs

Reorgs are detected, not assumed. At startup the runtime fetches the block at
the anchor height (`GET /extended/v2/blocks/{height}`) and compares its hash:

- **Same hash:** no reorg reached stored data. Only the data fetched above the
  anchor, which was never indexed, is discarded and refetched. Nothing is
  replayed through handlers. This costs one request.
- **Different hash, or no block at that height:** a reorg replaced the anchor.
  Stored blocks are a canonical prefix followed by orphaned blocks, so a binary
  search over the stored blocks between `finalizedBlockHeight` and the anchor
  finds the highest one that is still canonical. Everything above it is
  deleted, the affected contracts' `syncedBlockHeight` is lowered to it and their
  forward cursor dropped, and the checkpoint is lowered so the range is
  refetched and replayed through handlers.
- **The finalized block itself was replaced:** the run fails with `ReorgError`
  and changes nothing. Data at or below `finalizedBlockHeight` was reported as
  final, so the indexer cannot repair it silently: re-sync from an empty indexer
  database (and reset handler tables), and raise `finality` to tolerate deeper
  reorgs. With `finality: 0`, any reorg that replaces indexed blocks fails this
  way.

Without an anchor (first run after upgrading, or the chain tip could not be
read in the previous run) stored data cannot be verified, so everything above
`finalizedBlockHeight` is discarded and replayed.

The catch-up refetches from the canonical chain: the logs endpoint only returns
canonical events, and the catch-up follows cursors returned by the same walk.

Handler writes are not rolled back when a range is replayed, so handlers must
be idempotent: upsert by primary key, or delete-then-insert, so re-executing an
event produces the same final state. Writes for events that disappear in a
reorg are not undone.

```
┌─────────────────────────────────────────────────────────┐
│                     ON STARTUP                          │
├─────────────────────────────────────────────────────────┤
│  1. Read the chain tip            └─▶ 1100 / 0xabc…     │
│                                                         │
│  2. Verify the previous anchor    └─▶ block 1000        │
│     same hash: drop never-indexed data above 1000       │
│     changed:   binary search stored blocks in           │
│                [finalized, 1000] for the newest one     │
│                still canonical (e.g. 995), rewind       │
│                sync data and checkpoint to 995          │
│     finalized block changed: fail with ReorgError       │
│                                                         │
│  3. Save 1100 / 0xabc… as the new anchor                │
│                                                         │
│  4. Catch up: newest page, then prev_cursor back to     │
│     syncedBlockHeight                                   │
│                                                         │
│  5. Resume indexing from the checkpoint, up to 1100     │
└─────────────────────────────────────────────────────────┘
```

## Summary

| Component  | Purpose                          | Storage / Tech                                 |
| ---------- | -------------------------------- | ---------------------------------------------- |
| Syncer     | Fetch events, txs, blocks        | `events`, `transactions`, `blocks`             |
| Sync Store | Cache raw Stacks data            | PostgreSQL / PGlite                            |
| Indexer    | Execute handlers, transform data | user tables                                    |
| Checkpoint | Track progress, enable recovery  | `checkpoints`, `sync_progress`, `sync_anchors` |
