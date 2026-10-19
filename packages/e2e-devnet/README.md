# indexer-e2e-devnet

End-to-end tests that run stacksindex against a local [Clarinet](https://github.com/stx-labs/clarinet) devnet: a real Stacks node and stacks-blockchain-api in Docker, with the contracts in `clarinet/contracts` deployed.

## Prerequisites

- Docker, running.
- Clarinet `3.25.0` on `PATH` ([releases](https://github.com/stx-labs/clarinet/releases/tag/v3.25.0)). The suite checks the version before starting a devnet.
- On Linux, when your uid is not 1000: Clarinet copies its devnet snapshot (`~/.clarinet/cache/devnet`, `0600` files) into a directory that bitcoind reads as uid 1000, so bitcoind never serves RPC. After a first `clarinet devnet start` has extracted the snapshot, run `chmod -R a+rwX ~/.clarinet/cache/devnet`. CI does this in `.github/workflows/e2e-devnet.yml`.

## Run

```sh
vp run test:devnet
```

The suite is opt-in: `vp run test` does not run it.

- If no API answers on `http://localhost:3999`, the global setup starts `clarinet devnet start --no-dashboard --use-on-disk-deployment-plan`, waits for the seed history, and stops the devnet when the run ends. Clarinet logs go to `clarinet/.cache/devnet.log`.
- If a devnet is already running, the suite reuses it and leaves it running. Start one in `clarinet/` with `clarinet devnet start --use-on-disk-deployment-plan` to iterate faster.
- `STACKS_DEVNET_API_URL` points the suite at another API URL.

## Layout

- `clarinet/contracts`: `events.clar` prints every Clarity value type, batches of 50 events, value updates and an aborting call; `ledger.clar` interleaves its prints with a call into `events.clar`.
- `clarinet/deployments/default.devnet-plan.yaml`: deploys both contracts, then sends the fixed seed history (156 print events). It is edited by hand, so never regenerate it with `clarinet deployments generate`. Seed scenarios assert exact counts from it, so keep `src/seed.ts` in sync when changing the plan.
- `clarinet/requirements`: sources of the sBTC contracts Clarinet adds to every devnet plan, committed so a fresh checkout boots without filling `.cache/`.
- `clarinet/settings/Devnet.toml`: pins every Docker image. The stacks-blockchain-api version decides which endpoints the indexer can use.
- `src/scenarios`: seed scenarios index the deployment plan history; runtime scenarios send their own transactions from `RUNTIME_SENDER` and start indexing at the chain tip they read first. Files run one at a time because they share the chain and sender nonce.
