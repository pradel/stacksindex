---
"stacksindex": patch
---

Fix "Cursor not found" error during initial historical sync by querying the transaction's true `microblock_sequence` from `GET /extended/v1/tx/{tx_id}` instead of hardcoding `0`.
