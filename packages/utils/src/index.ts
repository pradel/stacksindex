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
  Effect.flatMap(
    api.fetchBlock("0xe690efd6ba4eaef6ae236bf1e20866175641e1dbf9d26218c08f5eb1698834f5"),
    (block) => Console.log({ block }),
  ),
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
