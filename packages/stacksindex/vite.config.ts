import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    dts: true,
    format: "esm",
    exports: true,
    publint: true,
    sourcemap: true,
    attw: {
      profile: "esm-only",
    },
  },
});
