import path from "node:path";

import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  resolve: {
    alias: [
      {
        find: /^stacksindex$/u,
        replacement: path.resolve(import.meta.dirname, "../stacksindex/src/index.ts"),
      },
      {
        find: /^stacksindex\/effect$/u,
        replacement: path.resolve(import.meta.dirname, "../stacksindex/src/effect.ts"),
      },
    ],
  },
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    globalSetup: "./src/global-setup.ts",
  },
});
