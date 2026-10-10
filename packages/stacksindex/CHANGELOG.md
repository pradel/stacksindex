# stacksindex

## 0.0.8

### Patch Changes

- [#62](https://github.com/pradel/stacksindex/pull/62) [`9f5081c`](https://github.com/pradel/stacksindex/commit/9f5081c1b20b3452b5245aa9c716a93c0079eba3) Thanks [@pradel](https://github.com/pradel)! - Initialize contracts concurrently instead of sequentially. Cursor discovery is network-bound, so runs with multiple caught-up contracts now overlap their initialization requests (bounded to 8 at a time) instead of paying for them one after another.

## 0.0.7

### Patch Changes

- [#59](https://github.com/pradel/stacksindex/pull/59) [`6890510`](https://github.com/pradel/stacksindex/commit/689051088358f67c7164ab127c4a8bd1ab095f93) Thanks [@pradel](https://github.com/pradel)! - Improved crash recovery by committing each indexed event batch and its checkpoint in a single database transaction. A crash while processing a batch no longer replays events that were already handled.

- [#55](https://github.com/pradel/stacksindex/pull/55) [`1992f67`](https://github.com/pradel/stacksindex/commit/1992f678e8266d0b407830aab6da77ab3759be36) Thanks [@pradel](https://github.com/pradel)! - Replace the consola logger with Effect's native logging and expose the runtime, indexing, and database as Effect services, with the promise API rebuilt as a boundary adapter.

- [#56](https://github.com/pradel/stacksindex/pull/56) [`3fb992e`](https://github.com/pradel/stacksindex/commit/3fb992ecc7d7575113da5851c5e20087ecc84196) Thanks [@pradel](https://github.com/pradel)! - Split the package into two entrypoints and redesign the public API. `stacksindex` is now the promise-native API and `stacksindex/effect` is the Effect-native API.

- [#60](https://github.com/pradel/stacksindex/pull/60) [`83422ec`](https://github.com/pradel/stacksindex/commit/83422ec44549687f0b382ceef52e761403be305f) Thanks [@pradel](https://github.com/pradel)! - Added a `finality` option that keeps a configurable number of trailing blocks unfinalized. Checkpoints now track a finalized block height, `RunResult` exposes it as `finalizedBlockHeight`, and unfinalized data is discarded and replayed after a restart so reorgs are handled automatically. Replayed handlers must be idempotent.

- [#61](https://github.com/pradel/stacksindex/pull/61) [`dd03780`](https://github.com/pradel/stacksindex/commit/dd0378068472ef47aa4104d73962c835e8d711da) Thanks [@pradel](https://github.com/pradel)! - Improved historical sync logging with `debug`-level page detail, periodic `Historical sync progress` lines with percent and ETA, slow-operation warnings, and a completion summary with run totals.

- [#58](https://github.com/pradel/stacksindex/pull/58) [`c5d2cc2`](https://github.com/pradel/stacksindex/commit/c5d2cc2316928188132a2ed55fcf47e3b513a73c) Thanks [@pradel](https://github.com/pradel)! - Build the promise entrypoint with `ManagedRuntime` and capture service dependencies when constructing `HistoricalRuntime` and `Indexing`, so `run` and `executeEvent` no longer require services.

- [#53](https://github.com/pradel/stacksindex/pull/53) [`0e654cf`](https://github.com/pradel/stacksindex/commit/0e654cfc9e24950fe3bbff49d3d8199f185b1654) Thanks [@pradel](https://github.com/pradel)! - Rework the Stacks API datasource around a single Effect-native `StacksClient`.

- [#60](https://github.com/pradel/stacksindex/pull/60) [`83422ec`](https://github.com/pradel/stacksindex/commit/83422ec44549687f0b382ceef52e761403be305f) Thanks [@pradel](https://github.com/pradel)! - Added Effect metrics for historical sync and indexing (`stacksindex.sync.pages`, `stacksindex.sync.events`, `stacksindex.sync.errors`, `stacksindex.index.batch_duration`), per-phase log annotations (`fetch`, `store`, `index`, `checkpoint`), and `pagesFetched`/`transactionsFetched` counters on `ContractRunResult`.

- [#57](https://github.com/pradel/stacksindex/pull/57) [`e0e83d8`](https://github.com/pradel/stacksindex/commit/e0e83d8978e8ad767cd91799b9a92dc2e5379f54) Thanks [@pradel](https://github.com/pradel)! - Decode runtime boundaries with Schema and replace `unknown` layer errors with typed `ConfigurationError`, `DatabaseError`, `MigrationError`, and `InvalidCursorError` failures.

## 0.0.6

### Patch Changes

- [#46](https://github.com/pradel/stacksindex/pull/46) [`10ea79e`](https://github.com/pradel/stacksindex/commit/10ea79e3dbb5bd28718d787184df3933204f593c) Thanks [@pradel](https://github.com/pradel)! - Migrate to Effect v4 and Drizzle ORM 1.0.

  - Replace `better-result` with Effect services, tagged errors, and schemas.
  - Upgrade to `drizzle-orm`/`drizzle-kit` 1.0 with the `@effect/sql` adapters and the new migration folder format.
  - Add `SyncStoreError`, run event handlers in a database transaction, and use `fetch` for Stacks API requests.
  - Support both Effect and Promise consumption (`toThenable`, `createHistoricalRuntimePromise`).

## 0.0.5

### Patch Changes

- [#42](https://github.com/pradel/stacksindex/pull/42) [`14a5b6d`](https://github.com/pradel/stacksindex/commit/14a5b6dc15aae08c2e6962441bc389b69d85e898) Thanks [@pradel](https://github.com/pradel)! - Replace deprecated `/extended/v1/status` endpoint with `/extended`.

- [#45](https://github.com/pradel/stacksindex/pull/45) [`7a6c31a`](https://github.com/pradel/stacksindex/commit/7a6c31ac295b564a511fafe7944046a68c770fac) Thanks [@pradel](https://github.com/pradel)! - Extract block data from transaction batch responses in memory instead of calling the block API. This eliminates all block network requests during historical sync, drastically reducing total HTTP calls by 10% to 54.5% and preventing API rate-limit bottlenecks.

- [#44](https://github.com/pradel/stacksindex/pull/44) [`79956f1`](https://github.com/pradel/stacksindex/commit/79956f1cb969356e76fd3d2d1f37ac5331c1fe0c) Thanks [@pradel](https://github.com/pradel)! - Replace deprecated `/extended/v1/contract/{contract_id}` endpoint with `/extended/v3/smart-contracts/{contract_id}`.

## 0.0.4

### Patch Changes

- [#39](https://github.com/pradel/stacksindex/pull/39) [`bc79d17`](https://github.com/pradel/stacksindex/commit/bc79d17a977072c6812f606405dc872a8edcda3c) Thanks [@pradel](https://github.com/pradel)! - Fix "Cursor not found" error during initial historical sync by querying the transaction's true `microblock_sequence` from `GET /extended/v1/tx/{tx_id}` instead of hardcoding `0`.

## 0.0.3

### Patch Changes

- [#34](https://github.com/pradel/stacksindex/pull/34) [`0b4ed4a`](https://github.com/pradel/stacksindex/commit/0b4ed4aef96fff31d8a509ee6c0b68456110da7a) Thanks [@pradel](https://github.com/pradel)! - Fetch missing transactions with the new `GET /extended/v3/transactions/batch` endpoint (up to 20 per request) instead of one request each. Backfills finish faster with far fewer API calls (119 to 42 in e2e) and less rate-limit pressure. Requires Stacks API 9.2.0+.

- [#37](https://github.com/pradel/stacksindex/pull/37) [`74a605b`](https://github.com/pradel/stacksindex/commit/74a605b8078b1fdd17bb0ba93372a26e2b7ff226) Thanks [@pradel](https://github.com/pradel)! - Replace the `chainId` runtime option with `network`: pass `"mainnet"` (default), `"testnet"`, or a custom chain ID number. The Stacks API endpoint now defaults per network (`https://api.hiro.so`, `https://api.testnet.hiro.so`) and `api.baseUrl` overrides it.

- [#36](https://github.com/pradel/stacksindex/pull/36) [`fc8f778`](https://github.com/pradel/stacksindex/commit/fc8f778a0729525048b36e6bbdb3dc021d259ccc) Thanks [@pradel](https://github.com/pradel)! - Remove the `canonical` column from the `transactions` table and all related handling. The Hiro v3 API only returns canonical chain data and no longer exposes a `canonical` field, so storing it was dead weight. Existing databases migrate automatically via `ALTER TABLE "transactions" DROP COLUMN "canonical"`.

## 0.0.2

### Patch Changes

- [`085bf86`](https://github.com/pradel/stacksindex/commit/085bf863cb286cdb81842eaae20b31fca43b990b) Thanks [@pradel](https://github.com/pradel)! - Automate CI publishing process.

## 0.0.1

### Patch Changes

- [#27](https://github.com/pradel/stacksindex/pull/27) [`97b5d79`](https://github.com/pradel/stacksindex/commit/97b5d79bb0a7e8542892b5212a50fe6f90b55ba0) Thanks [@pradel](https://github.com/pradel)! - Initial v0.0.1 release of `stacksindex`, a simple and open-source historical indexer for the Stacks blockchain.

  ### Features
  - **Historical Backfill**: Cursor-based smart contract log indexing with automatic genesis cursor discovery
  - **Database Flexibility**: Support for embedded PGlite and PostgreSQL via Drizzle ORM
  - **Typed Read-Only Contract Calls**: Pinned time-travel state lookups with Clarity ABI support
  - **Clarity Value Codec**: Built-in decoding for Clarity values and hex strings (`decodeHex`, `cvToJSON`)
  - **Fault-Tolerant & Crash Recovery**: Checkpointing and resume from last indexed block height
  - **Multi-Network Support**: Configurable `chainId` and Stacks API endpoints
