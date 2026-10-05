---
"stacksindex": minor
---

Use the native Effect HTTP client in the Stacks API datasource.

- `datasourceStacksApi` methods and `typedCallReadFunction` now require `HttpClient.HttpClient` in the environment; `createHistoricalRuntime` provides `FetchHttpClient.layer` once per run.
- Requests are built with native `HttpClientRequest` combinators (`urlParams`, `bodyJson`) instead of manual URL encoding.
- Retries are handled by a single error-aware `Effect.retry` schedule that honors `Retry-After` and backs off with jitter for transient 5xx responses.
- `StacksClient.layer` captures the `HttpClient` service so its methods stay requirement-free.
