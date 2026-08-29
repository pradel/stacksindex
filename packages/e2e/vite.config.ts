import { defineConfig } from "vite-plus";

export default defineConfig({
  test: {
    testTimeout: 120000,
    hookTimeout: 120000,
  },
});
