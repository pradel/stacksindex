---
"stacksindex": patch
---

Upgrade dependencies: `effect`, `@effect/sql-pg` and `@effect/sql-pglite` 4.1.4, `drizzle-orm` 1.0.0-rc.5 and `@stacks/transactions` 7.7.0. The `drizzle-orm` peer range is now `^1.0.0-rc.5`. `IndexerDb` is now drizzle's shared Effect Postgres database type instead of a union of the PGlite and Postgres ones; raw `db.execute` results stay untyped.
