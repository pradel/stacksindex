---
"stacksindex": minor
---

Breaking: the indexer's tables move to a dedicated `stacksindex` Postgres schema, so your own tables can live in `public` of the same database without name collisions. Opening the database (`createIndexer`, `IndexerDatabase.layer`) now creates or upgrades them, and their migrations are tracked in `stacksindex.__drizzle_migrations`. `migrate({ migrationsFolder })` now only applies your drizzle-kit migrations, tracked in drizzle's default `drizzle.__drizzle_migrations`, and `migrationsFolder` is required. `makeDatabase` and `getMigrationsFolder` are removed. Existing indexer databases are not migrated: delete the database and re-sync from scratch.
