---
"stacksindex": minor
---

Guard the indexer database. `run` and `live` hold a lock for their chain on Postgres, so a second indexer of the same chain on the same database fails with the new `LockError` instead of applying events twice. Processes opening a new database at the same time now apply its migrations one after the other. A database upgraded by a newer stacksindex, or holding data in a format this version cannot read (tracked in a new `stacksindex.version` table), fails to open with `MigrationError`.
