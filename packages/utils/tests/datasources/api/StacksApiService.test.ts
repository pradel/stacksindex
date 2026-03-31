import { HttpClient, HttpClientResponse } from "@effect/platform";
import { Cause, Effect, Layer, Option } from "effect";
import { expect, test } from "vite-plus/test";

import {
  StacksApiParseError,
  StacksApiResponseError,
} from "../../../src/datasources/api/Errors.js";
import { StacksApiServiceLive } from "../../../src/datasources/api/internal/StacksApiServiceImpl.js";
import { StacksApiService } from "../../../src/datasources/api/StacksApiService.js";

const TEST_HASH = "0xe690efd6ba4eaef6ae236bf1e20866175641e1dbf9d26218c08f5eb1698834f5";

const VALID_BLOCK_RESPONSE = {
  hash: TEST_HASH,
  height: 123456,
  block_time: 1710000000,
};

test("fetchBlock returns block for valid hash", () =>
  Effect.gen(function* () {
    const mockClient = HttpClient.make((request, _url) => {
      expect(request.url).toContain(`/extended/v2/blocks/${TEST_HASH}`);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(VALID_BLOCK_RESPONSE), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    });

    const testLayer = Layer.succeed(HttpClient.HttpClient, mockClient);

    const program = Effect.flatMap(StacksApiService, (api) => api.fetchBlock(TEST_HASH));

    const block = yield* Effect.provide(
      program,
      Layer.merge(
        testLayer,
        StacksApiServiceLive({
          baseUrl: "https://api.hiro.so",
        }),
      ),
    );

    expect(block.hash).toBe(TEST_HASH);
    expect(block.height).toBe(123456);
    expect(block.block_time).toBe(1710000000);
  }));

test("fetchBlock throws StacksApiParseError for invalid JSON", () =>
  Effect.gen(function* () {
    const mockClient = HttpClient.make((request, _url) => {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response("not valid json", {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    });

    const testLayer = Layer.succeed(HttpClient.HttpClient, mockClient);

    const program = Effect.flatMap(StacksApiService, (api) => api.fetchBlock(TEST_HASH));

    const result = yield* Effect.exit(
      Effect.provide(
        program,
        Layer.merge(
          testLayer,
          StacksApiServiceLive({
            baseUrl: "https://api.hiro.so",
          }),
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = Option.getOrElse(Cause.failureOption(result.cause), () => null);
      expect(error).toBeInstanceOf(StacksApiParseError);
    }
  }));

test("fetchBlock throws StacksApiResponseError for 404", () =>
  Effect.gen(function* () {
    const mockClient = HttpClient.make((request, _url) => {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify({ error: "not found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      );
    });

    const testLayer = Layer.succeed(HttpClient.HttpClient, mockClient);

    const program = Effect.flatMap(StacksApiService, (api) => api.fetchBlock(TEST_HASH));

    const result = yield* Effect.exit(
      Effect.provide(
        program,
        Layer.merge(
          testLayer,
          StacksApiServiceLive({
            baseUrl: "https://api.hiro.so",
          }),
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      const error = Option.getOrElse(Cause.failureOption(result.cause), () => null);
      expect(error).toBeInstanceOf(StacksApiResponseError);
      if (error instanceof StacksApiResponseError) {
        expect(error.status).toBe(404);
      }
    }
  }));
