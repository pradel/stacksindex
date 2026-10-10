---
"stacksindex": patch
---

Initialize contracts concurrently instead of sequentially. Cursor discovery is network-bound, so runs with multiple caught-up contracts now overlap their initialization requests (bounded to 8 at a time) instead of paying for them one after another.
