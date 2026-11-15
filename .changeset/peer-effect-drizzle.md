---
"stacksindex": minor
---

Breaking: `effect` (`^4.1.4`) is now a peer dependency, and `drizzle-orm` is only a peer dependency (`^1.0.0-rc.5`) instead of also a pinned dependency. Your application's single copy of each is used, so Effect layers, services and drizzle tables are no longer split across two copies when your versions differ. Install `effect` alongside `stacksindex` if your package manager does not install peers automatically.
