# stacksindex

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
