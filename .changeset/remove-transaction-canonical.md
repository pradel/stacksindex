---
"stacksindex": minor
---

Remove the `canonical` column from the `transactions` table and all related handling. The Hiro v3 API only returns canonical chain data and no longer exposes a `canonical` field, so storing it was dead weight. Existing databases migrate automatically via `ALTER TABLE "transactions" DROP COLUMN "canonical"`.
