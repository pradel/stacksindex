import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: {
    "*": "vp check --fix",
  },
  fmt: {
    sortImports: true,
  },
  lint: {
    categories: {
      correctness: "error",
      nursery: "error",
      perf: "error",
      suspicious: "error",
      pedantic: "error",
      restriction: "error",
      style: "error",
    },
    options: { typeAware: true, typeCheck: true },
    rules: {
      // Handled by oxfmt already
      "sort-imports": "off",
      "max-lines-per-function": "off",
      "max-classes-per-file": "off",
      // Disabled in favor of typescript/require-await
      "require-await": "off",
      "no-ternary": "off",
      "no-magic-numbers": "off",
      "new-cap": "off",
      "oxc/no-async-await": "off",
      "typescript/promise-function-async": "off",
      "typescript/explicit-function-return-type": "off",
      "typescript/explicit-module-boundary-types": "off",
      "unicorn/no-null": "off",

      "sort-keys": "off",
    },
  },
  run: {
    cache: true,
  },
});
