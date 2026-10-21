---
"stacksindex": minor
---

Breaking: `network` is renamed `chain` and takes `"mainnet"`, `"testnet"` or `{ id, apiUrl }` for any other chain, and `api.baseUrl` is renamed `api.url`. `resolveNetwork`, `NetworkOption`, `MAINNET_API_BASE_URL` and `TESTNET_API_BASE_URL` become `resolveChain`, `ChainOption`, `MAINNET_API_URL` and `TESTNET_API_URL`.
