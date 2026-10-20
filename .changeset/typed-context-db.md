---
"stacksindex": minor
---

Write your tables through `context.db`: handler writes commit with the indexing checkpoint, so a crash or a failed batch never applies an event twice. Pass Drizzle `relations` to `createIndexer` or `Indexer.layerWithDatabase` for typed `db.query` (`EventHandler<typeof relations>`).
