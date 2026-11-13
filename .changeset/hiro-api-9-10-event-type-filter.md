---
"stacksindex": patch
---

Request only `contract_log` events from `GET /extended/v3/transactions/{tx_id}/events` with the `type` filter that Stacks API 9.10.0 adds, in cursor discovery and in live per-block sync. Token, STX and lock events no longer fill event pages, so a transaction with many transfers before its print costs one events request instead of several. Requires Stacks API 9.10.0+. Upgrades `@stacks/blockchain-api-client` to 9.10.0.
