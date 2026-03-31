import { HttpClient, HttpClientRequest, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, Redacted } from "effect";
import { ParseError } from "effect/ParseResult";

import type { Block } from "../Block.js";
import { BlockSchema } from "../Block.js";
import { fromHttpClientError, fromParseError } from "../Errors.js";
import type { StacksApiError } from "../Errors.js";
import { StacksApiService } from "../StacksApiService.js";
import type { StacksApiServiceConfig } from "../StacksApiService.js";

const makeStacksApiService = (
  config: StacksApiServiceConfig,
): Effect.Effect<StacksApiService, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient;

    const client = baseClient.pipe(
      HttpClient.filterStatusOk,
      HttpClient.mapRequest((request) => {
        let req = request.pipe(
          HttpClientRequest.prependUrl(config.baseUrl),
          HttpClientRequest.acceptJson,
        );

        if (config.apiKey) {
          req = req.pipe(HttpClientRequest.bearerToken(Redacted.value(config.apiKey)));
        }

        return req;
      }),
    );

    const fetchBlock = (height: bigint): Effect.Effect<Block, StacksApiError> => {
      const request = Effect.flatMap(
        client.execute(HttpClientRequest.get(`/extended/v2/blocks/${height}`)),
        (response) => HttpClientResponse.schemaBodyJson(BlockSchema)(response),
      );

      return Effect.mapError(
        request,
        (error): StacksApiError =>
          error instanceof ParseError ? fromParseError(error) : fromHttpClientError(error),
      );
    };

    return StacksApiService.of({ fetchBlock });
  });

export const StacksApiServiceLive = (
  config: StacksApiServiceConfig,
): Layer.Layer<StacksApiService, never, HttpClient.HttpClient> =>
  Layer.scoped(StacksApiService, makeStacksApiService(config));
