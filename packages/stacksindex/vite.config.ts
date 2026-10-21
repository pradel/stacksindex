import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: {
      index: "src/index.ts",
      effect: "src/effect.ts",
      clarity: "src/clarity.ts",
    },
    deps: { resolveDepSubpath: true },
    dts: true,
    format: "esm",
    exports: true,
    publint: true,
    sourcemap: true,
    attw: {
      profile: "esm-only",
    },
  },
  test: {
    setupFiles: ["./src/test-utils/vitest-setup.ts"],
    // Drops the Postgres databases tests create when STACKSINDEX_TEST_POSTGRES_URL is set.
    globalSetup: ["./src/test/postgres-global-setup.ts"],
    // Tests and their `beforeAll` hooks open fresh PGlite databases (WASM init
    // Plus migrations): about 1s alone, but well past Vitest's defaults (5s,
    // 10s for hooks) on a busy machine or CI runner running every file at once.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
