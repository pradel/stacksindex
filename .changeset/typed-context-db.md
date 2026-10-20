---
"stacksindex": minor
---

Make `context.db` the default place for handler writes: put your tables in the indexer database and write them through `context.db`, which commits together with the indexing checkpoint, so a crash or a failed batch never applies an event twice. Pass Drizzle `relations` (from `defineRelations`) to `createIndexer` or `Indexer.layerWithDatabase` to enable typed `db.query` on `indexer.db` and `context.db`; `HandlerContext`, `EventHandler`, `Filter` and the promise `Indexer` take the relations type (`EventHandler<typeof relations>`). Without `relations`, the promise types expose no `db.query` tables, matching the database drizzle builds. With the promise API, `db.query.<table>` builders can be awaited. The examples now keep their tables in the indexer database.
