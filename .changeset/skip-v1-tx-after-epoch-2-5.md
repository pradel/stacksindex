---
"stacksindex": patch
---

Cursor discovery no longer calls the deprecated `GET /extended/v1/tx/{tx_id}` when a contract's first event is at or after epoch 2.5 (Bitcoin height 840,360 on mainnet, 6 on testnet). Blocks cannot confirm microblocks from then on, so the cursor's `microblock_sequence` is always `2147483647`. Older events and other chains still look it up.
