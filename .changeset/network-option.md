---
"stacksindex": patch
---

Replace the `chainId` runtime option with `network`: pass `"mainnet"` (default), `"testnet"`, or a custom chain ID number. The Stacks API endpoint now defaults per network (`https://api.hiro.so`, `https://api.testnet.hiro.so`) and `api.baseUrl` overrides it.
