---
"stacksindex": minor
---

Breaking: build the database with `pglite(directory?)` or `postgres(connectionString)` (the `DatabaseConfig` type is now `Database`), and pass your drizzle-kit migrations folder as `migrations` to `createIndexer` or `Indexer.layerWithDatabase`; it is applied when the database opens. `indexer.migrate()` and the Effect `migrate` are removed.
