---
"stacksindex": patch
---

Fix historical sync missing up to 99 of a contract's newest events by finishing each contract from its newest logs page. A caught-up contract is now checked with a single request instead of re-running first-event discovery. Re-sync from an empty indexer database to recover events skipped by previous versions.
