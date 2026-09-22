import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
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
  },
});
