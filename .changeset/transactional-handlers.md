---
"stacksindex": patch
---

Run event handlers inside a database transaction so handler writes are committed atomically and rolled back when a handler throws.
