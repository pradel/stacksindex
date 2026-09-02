import { defineConfig } from "vite-plus";

export default defineConfig({
  root: import.meta.dirname,
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
    globalSetup: "./src/global-setup.ts",
  },
});
