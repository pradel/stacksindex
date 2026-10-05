---
"stacksindex": minor
---

Rework the Stacks API datasource around a single Effect-native `StacksClient`.

- `StacksClient.layer(config)` (fetch transport, adaptive rate limiter, retries) and `StacksClient.make(config)` replace `datasourceStacksApi`. Typed reads use `readOnly(client.callReadFunction, parameters)`.
- Responses are not decoded at runtime. Transient transport/5xx failures are retried with backoff, and 429s are retried by the rate limiter using `x-ratelimit-*` and `Retry-After`.
- Errors are Effect's `HttpClientError` reasons (`StacksApiError = HttpClientError | RateLimiterError | ReadOnlyCallError`); the custom `StacksApi*` errors are removed, read-only ABI validation failures are defects, and an incomplete transaction batch fails with `TransactionBatchError`.
