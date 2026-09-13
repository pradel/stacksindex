---
"stacksindex": minor
---

Migrate to Effect.js v4 and Drizzle ORM v1.0:

- Replace `better-result` with native Effect services, tagged errors, and schemas.
- Upgrade Drizzle ORM to v1.0 with `@effect/sql-pg` and `@effect/sql-pglite`.
- Implement concurrent historical sync and indexing fibers communicating via queues.
- Support dual API consumption with `toThenable` and `createHistoricalRuntimePromise`.
