import { expect } from "vite-plus/test";

import { toBeErr } from "./result-matchers.ts";

expect.extend({ toBeErr });
