# stacksindex

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
