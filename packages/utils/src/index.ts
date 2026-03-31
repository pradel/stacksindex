import { NodeHttpClient } from "@effect/platform-node";
import { Effect } from "effect";

import { StacksApiServiceLive } from "./datasources/api/index.js";
import { StacksApiService } from "./datasources/api/StacksApiService.ts";

const program = Effect.flatMap(StacksApiService, (api) => api.fetchBlock(100n)).pipe(
  Effect.provide(
    StacksApiServiceLive({
      baseUrl: "https://api.hiro.so",
    }),
  ),
  Effect.provide(NodeHttpClient.layer),
);

await Effect.runPromiseExit(program);
