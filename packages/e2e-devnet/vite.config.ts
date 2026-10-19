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
    // Every file shares one devnet chain and the same sender accounts.
    fileParallelism: false,
    testTimeout: 180000,
    hookTimeout: 180000,
    globalSetup: "./src/global-setup.ts",
  },
});
