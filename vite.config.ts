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
    plugins: ["node", "typescript", "vitest"],
    options: { typeAware: true, typeCheck: true },
    rules: {
      "sort-imports": "off",
      "max-lines-per-function": "off",
      "max-classes-per-file": "off",
      "max-statements": "off",
      "require-await": "off",
      "no-ternary": "off",
      "no-magic-numbers": "off",
      "no-warning-comments": "off",
      "new-cap": "off",
      "no-undefined": "off",
      "oxc/no-async-await": "off",
      "typescript/promise-function-async": "off",
      "typescript/explicit-function-return-type": "off",
      "typescript/explicit-module-boundary-types": "off",
      "typescript/prefer-readonly-parameter-types": "off",
      "typescript/strict-boolean-expressions": "off",
      "typescript/consistent-indexed-object-style": "off",
      "unicorn/no-null": "off",
      "func-style": "off",
      "vitest/require-test-timeout": "off",
      "vitest/require-mock-type-parameters": "off",
      "vitest/prefer-to-be-truthy": "off",
      "vitest/no-hooks": "off",
      "vitest/prefer-import-in-mock": "off",
      "jest/consistent-test-it": "off",
      "jest/prefer-ending-with-an-expect": "off",

      "sort-keys": "off",
      "vitest/prefer-importing-vitest-globals": "off",
    },
  },
  run: {
    cache: true,
  },
});
