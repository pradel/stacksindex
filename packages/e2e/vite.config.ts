import path from "node:path";

import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: {
      stacksindex: path.resolve(import.meta.dirname, "../stacksindex/src/index.ts"),
    },
  },
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    globalSetup: "./src/global-setup.ts",
  },
});
