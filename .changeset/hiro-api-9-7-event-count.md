---
"stacksindex": patch
---

Use the `event_count` that Stacks API 9.7.0 adds to v3 transaction summaries. Cursor discovery reads it from the principal transactions page and no longer requests `GET /extended/v3/transactions/{tx_id}` for each scanned transaction. Live per-block sync skips the events request for transactions without events, and for `token_transfer`, `tenure_change` and `poison_microblock` transactions, which never carry contract logs. Requires Stacks API 9.7.0+. Upgrades `@stacks/blockchain-api-client` to 9.7.0.
