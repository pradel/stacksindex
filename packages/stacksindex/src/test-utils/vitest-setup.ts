import { expect } from "vite-plus/test";

import { toBeBetterErr } from "./result-matchers.ts";

expect.extend({ toBeBetterErr });
