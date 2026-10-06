---
"stacksindex": minor
---

Split the package into two entrypoints and redesign the public API.

- `stacksindex` is now the promise-native API and `stacksindex/effect` is the Effect-native API. Effect services, layers, and helpers (`HistoricalRuntime`, `IndexerDatabase`, `StacksClient`, `readOnly`, `loggerLayer`, `makeDatabase`, `migrate`, `getMigrationsFolder`, `decodeClarityWithSchema`) moved to `stacksindex/effect`.
- Promise consumers now use `createHistoricalRuntime({ database, network, api, logLevel })`, which owns the database and runtime lifecycle and exposes `run`, `db`, `migrate`, `close` and `[Symbol.asyncDispose]`. `createDatabase`, `createHistoricalRuntimePromise` and all `Promise*` types were removed.
- `run` accepts a single filter or an array and resolves with a `RunResult` (`eventsProcessed` plus per-contract status, last block height and event count) instead of `void`.
- `HistoricalRuntime.layerWithDatabase(options)` provides `HistoricalRuntime`, `IndexerDatabase` and the logger from a single config.
- Read-only calls now take `contractId` instead of `contractAddress`/`contractName`, and untyped calls return decoded Clarity values, failing with `ReadOnlyCallError` on chain-level errors.
- The promise handler context is now `{ db, client, logger }`; `decode` was removed in favor of `decodeHex` plus your validator of choice.
