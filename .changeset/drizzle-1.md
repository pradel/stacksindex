---
"stacksindex": minor
---

Upgrade Drizzle ORM and Drizzle Kit to v1.0.

- `drizzle-orm` is now a `^1.0.0-rc.5-5935859` peer dependency.
- Migrations use the new drizzle-kit folder layout (`<timestamp>_<name>/migration.sql` + `snapshot.json`) instead of `meta/_journal.json`, converted with `drizzle-kit up`.
- Existing databases are upgraded in place by the v1.0 migrator: it backfills migration names and re-runs nothing (the SQL hash is unchanged).
