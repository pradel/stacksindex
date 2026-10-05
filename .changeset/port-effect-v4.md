---
"stacksindex": patch
---

Migrate to Effect v4 and Drizzle ORM 1.0.

- Replace `better-result` with Effect services, tagged errors, and schemas.
- Upgrade to `drizzle-orm`/`drizzle-kit` 1.0 with the `@effect/sql` adapters and the new migration folder format.
- Add `SyncStoreError`, run event handlers in a database transaction, and use `fetch` for Stacks API requests.
- Support both Effect and Promise consumption (`toThenable`, `createHistoricalRuntimePromise`).
