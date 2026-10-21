---
"stacksindex": patch
---

Reject filters that repeat a contract id, which previously kept only the last handler and silently dropped the others, and contract ids that are not `<principal>.<contract-name>`. Both fail `run`/`live` with `FilterValidationError` before any request.
