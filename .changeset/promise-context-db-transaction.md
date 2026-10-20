---
"stacksindex": patch
---

Run awaited `context.db` queries in promise handlers inside the batch transaction. They previously ran outside it: on PGlite they deadlocked, and on Postgres they committed on a separate connection instead of with the batch checkpoint. Awaiting `insert`, `update`, `delete`, `execute`, `$count` and relational queries is now typed as well, not only `select`.
