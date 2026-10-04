# Vendored anti-slop Oxlint plugins

Source repository: [dmmulroy/anti-slop](https://github.com/dmmulroy/anti-slop), commit
`c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (skill `skills/install-anti-slop`, bundle source
`skills/install-anti-slop/assets/anti-slop`). Every copied file matched that revision
byte-for-byte at install time, verified by clone and diff, except for the import deviation below.
The installing skill was locked in `skills-lock.json` (`install-anti-slop`, computedHash
`4031728fbe75bdcad6ee3208fd52b5d66e167b056fefee1fa9758e9a6cb9c0c8`).

Installed from that bundle on 2026-10-04 into:

- `tools/oxlint/anti-slop/index.ts` — generic plugin (`anti-slop`)
- `tools/oxlint/anti-slop/effect/index.ts` — opt-in Effect plugin (`anti-slop-effect`)
- `tools/oxlint/anti-slop/vendor/eslint-stylistic/**` — vendored padding-line rule and license,
  with its own provenance in `vendor/eslint-stylistic/UPSTREAM.md`

## Intentional deviations

- Every `@oxlint/plugins` import in the copied source was rewritten to `vite-plus/lint/plugins`.
  Vite+ bundles Oxlint, so this re-export always matches the loading linter and resolves under
  pnpm's strict layout. No `oxlint` or `@oxlint/plugins` dependency is installed.
  See `node_modules/vite-plus/docs/guide/lint.md` ("Use them instead of adding `@oxlint/plugins`
  or `oxlint` as a direct dependency"). This is the only source difference from upstream.
- The Effect plugin is registered and its five rules enabled ahead of the app that will use
  Effect, at the user's request. `anti-slop-effect/no-service-constructor-imports` analyzes
  relative project imports; package-alias imports are not covered.
- `vite.config.ts` enables all generic rules at `error`, `oxc/no-accumulating-spread`, and the
  Effect rules, and ignores `tools/oxlint/anti-slop/**` plus project-local agent directories in
  both lint and format configuration.

## Verification

- `vp check` loads both plugins; formatting passes.
- Smoke test: a scratch file comparing `value._tag === "SomeError"` was reported by
  `anti-slop-effect/no-manual-tag-comparison` and `anti-slop-effect/no-manual-tagged-construction`.
- Installing the rules surfaced pre-existing findings in owned source (945 anti-slop errors, 728
  of them `require-readable-spacing`). Install scope only: findings were reported, not fixed.
