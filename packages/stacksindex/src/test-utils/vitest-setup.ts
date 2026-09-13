import { expect } from "vite-plus/test";

import { toBeBetterErr, toBeTaggedError } from "./result-matchers.ts";

expect.extend({ toBeBetterErr, toBeTaggedError });
