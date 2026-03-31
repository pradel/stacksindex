import { NodeHttpClient } from "@effect/platform-node";
import { Effect, Console } from "effect";

import {
  StacksApiServiceLive,
  StacksApiRequestError,
  StacksApiResponseError,
  StacksApiParseError,
} from "./datasources/api/index.js";
import { StacksApiService } from "./datasources/api/StacksApiService.ts";

const program = Effect.flatMap(StacksApiService, (api) =>
  Effect.flatMap(api.fetchBlock(100n), (block) => Console.log({ block })),
).pipe(
  Effect.catchAll((error) => {
    if (error instanceof StacksApiRequestError) {
      return Console.log("RequestError:", error.cause);
    }
    if (error instanceof StacksApiResponseError) {
      return Console.log("ResponseError:", error.status, error.cause);
    }
    if (error instanceof StacksApiParseError) {
      return Console.log("ParseError:", error.cause);
    }
    return Console.log("Unknown error:", error);
  }),
  Effect.provide(
    StacksApiServiceLive({
      baseUrl: "https://api.hiro.so",
    }),
  ),
  Effect.provide(NodeHttpClient.layer),
);

await Effect.runPromiseExit(program);
