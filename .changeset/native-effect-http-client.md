---
"stacksindex": minor
---

Redesign the Stacks API datasource around a single Effect-native client.

- `StacksClient` is now the only API: `StacksClient.layer(config)` builds a self-contained client (fetch transport, adaptive rate limiter, retry policy) and `StacksClient.make(config)` exposes the raw effect for custom transports. `datasourceStacksApi`, `DatasourceStacksApiContext`, and the `StacksClientConfig` service tag are removed.
- Requests run through one executor: non-2xx responses are turned into errors once, a single `retryTransient` policy retries transport and transient HTTP failures 3 times with jittered exponential backoff honoring `Retry-After`, and `withRateLimiter` adapts the budget from `x-ratelimit-*` headers and 429 feedback.
- Responses are trusted, not decoded: no runtime schema validation, so the hot path does no extra allocation.
- Typed read-only calls are now `readOnly(client.callReadFunction, parameters)` instead of a context/callback wrapper.
- Error taxonomy simplified: `StacksApiResponseError` (`status`, `path`, `body`), `StacksApiTransportError`, `StacksApiParseError`, and `StacksApiUnexpectedError`. `StacksApiRateLimitError` is removed; an unrecoverable 429 surfaces as `StacksApiResponseError` with status 429.
- Requests emit `StacksApi.request` spans and Effect debug logs (`Effect.annotateLogs`/`logDebug`); no logger is threaded through the datasource.
