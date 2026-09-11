---
"stacksindex": patch
---

Fetch missing transactions with the new `GET /extended/v3/transactions/batch` endpoint (up to 20 per request) instead of one request each. Backfills finish faster with far fewer API calls (119 to 42 in e2e) and less rate-limit pressure. Requires Stacks API 9.2.0+.
