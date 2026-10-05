---
"stacksindex": minor
---

Redesign the Stacks API datasource around a single Effect-native client.

- `StacksClient` is now the only API: `StacksClient.layer(config)` builds a self-contained client (fetch transport, adaptive rate limiter, retry policy) and `StacksClient.make(config)` exposes the raw effect for custom transports. `datasourceStacksApi`, `DatasourceStacksApiContext`, and the `StacksClientConfig` service tag are removed.
- Requests run through one executor: non-2xx responses are turned into errors once, a single `retryTransient` policy retries transport and transient HTTP failures 3 times with jittered exponential backoff honoring `Retry-After`, and `withRateLimiter` adapts the budget from `x-ratelimit-*` headers and 429 feedback.
- Responses are trusted, not decoded: no runtime schema validation, so the hot path does no extra allocation.
- Typed read-only calls are now `readOnly(client.callReadFunction, parameters)` instead of a context/callback wrapper.
- Error handling now uses Effect's built-in `HttpClientError` reasons (`StatusCodeError`, `TransportError`, `DecodeError`); `StacksApiResponseError`, `StacksApiTransportError`, `StacksApiParseError`, and `StacksApiRateLimitError` are removed. `StacksApiError` is an alias for `HttpClientError | RateLimiterError | ReadOnlyCallError`.
- Read-only ABI validation failures are defects (`Effect.die`); a contract-level `(err ...)` or undecodable result fails with `ReadOnlyCallError`.
- The batch endpoint omitting requested transactions now fails with `TransactionBatchError` (runtime error) instead of a datasource error.
- Requests emit `StacksApi.request` spans and Effect debug logs (`Effect.annotateLogs`/`logDebug`); no logger is threaded through the datasource.
