---
"stacksindex": patch
---

Stacks API requests time out after 30 seconds and are retried 6 times over about 30 seconds (previously 3 times over about 3.5 seconds, with no timeout), so a hung request no longer stalls a run and a short outage no longer fails it. `live` also retries its initial historical sync under the same failure budget as new heads, instead of failing on the first API error.
