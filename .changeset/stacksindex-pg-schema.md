---
"stacksindex": minor
---

Breaking: the indexer's tables move to a `stacksindex` Postgres schema, leaving `public` to your tables, and are created when the database opens. `migrate({ migrationsFolder })` now only applies your migrations. `makeDatabase` and `getMigrationsFolder` are removed. Existing indexer databases must be deleted and re-synced.
