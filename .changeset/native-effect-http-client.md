---
"stacksindex": minor
---

Use the native Effect HTTP client and the `StacksClient` service in the Stacks API datasource.

- `datasourceStacksApi` methods and `typedCallReadFunction` now require `HttpClient.HttpClient` in the environment; `createHistoricalRuntime` provides it once per run.
- Requests are built with native `HttpClientRequest` combinators (`urlParams`, `bodyJson`) instead of manual URL encoding.
- Retries are handled by a single error-aware `Effect.retry` schedule that honors `Retry-After` and backs off with jitter for transient 5xx responses.
- `StacksClient` now exposes the full datasource surface and is used internally by the runtime, historical sync, and indexing instead of threading `DatasourceStacksApiContext` around.
- Requests are proactively rate limited with `HttpClient.withRateLimiter`: the budget adapts to `x-ratelimit-*` response headers and 429 feedback, and can be configured through `api.rateLimit` on `createHistoricalRuntime`.
- Each request emits a `StacksApi.request` span (method, path, status) and logs debug entries through the runtime logger; transient 408 and 504 responses are retried alongside other 5xx statuses.
- `StacksClient.layer(options)` builds a self-contained client (fetch transport plus in-memory limiter) and `StacksClient.baseLayer` remains available for custom transports.
