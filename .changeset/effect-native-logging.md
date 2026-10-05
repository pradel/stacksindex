---
"stacksindex": minor
---

Use Effect's native logging and remove the consola-based logger:

- `createLogger` and the `Logger` type are removed. Provide `loggerLayer({ level })` at the composition root and log with `Effect.logInfo`, `Effect.logDebug`, and `Effect.logError`, using `Effect.annotateLogs` for structured fields and `Effect.withLogSpan` for durations.
- The `logger` option is removed from the historical runtime context.
