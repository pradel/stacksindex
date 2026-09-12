---
"stacksindex": patch
---

Extract block data from transaction batch responses in memory instead of calling the block API. This eliminates all block network requests during historical sync, drastically reducing total HTTP calls by 10% to 54.5% and preventing API rate-limit bottlenecks.
