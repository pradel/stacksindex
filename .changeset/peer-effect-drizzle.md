---
"stacksindex": minor
---

`drizzle-orm` is now only a peer dependency (`^1.0.0-rc.5`), so stacksindex and your tables share your application's copy. `effect`, `@effect/sql-pg` and `@effect/sql-pglite` stay dependencies, but now use `^4.1.4` ranges instead of exact pins, so they dedupe with your application's Effect 4 packages instead of installing a second copy. With Yarn PnP, add `effect`, `@effect/sql-pg` and `@effect/sql-pglite` to your application, because drizzle-orm loads them as its own peers.
