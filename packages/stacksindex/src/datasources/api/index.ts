import type { paths } from "@stacks/blockchain-api-client";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Metric,
  Predicate,
  Schedule,
} from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  type UrlParams,
} from "effect/http";
import { RateLimiter } from "effect/persistence";

import { apiRequestDuration, apiResponses } from "../../lib/metrics.ts";
import { DEFAULT_SENDER, type StacksHttpError } from "./read-only.ts";

export { readOnly, ReadOnlyCallError } from "./read-only.ts";

export type {
  CallReadFunction,
  ContractFunctionArgs,
  StacksApiError,
  StacksHttpError,
  ContractFunctionName,
  ContractFunctionReturnType,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "./read-only.ts";

export type BlocksApiResponse =
  paths["/extended/v2/blocks/"]["get"]["responses"]["200"]["content"]["application/json"];

/** Pagination for `GET /extended/v2/blocks`; the API caps `limit` at 30. */
type GetBlocksQuery = paths["/extended/v2/blocks/"]["get"]["parameters"]["query"];

type BlockApiResponse =
  paths["/extended/v2/blocks/{height_or_hash}"]["get"]["responses"]["200"]["content"]["application/json"];

type GetBlockQuery = paths["/extended/v2/blocks/{height_or_hash}"]["get"]["parameters"]["query"];

export type BlockTransactionsApiResponse =
  paths["/extended/v3/blocks/{height_or_hash}/transactions"]["get"]["responses"]["200"]["content"]["application/json"];

type GetBlockTransactionsQuery =
  paths["/extended/v3/blocks/{height_or_hash}/transactions"]["get"]["parameters"]["query"];

type GetContractLogsQuery =
  paths["/extended/v2/smart-contracts/{contract_id}/logs"]["get"]["parameters"]["query"];

type TransactionsBatchResponse =
  paths["/extended/v3/transactions/batch"]["get"]["responses"]["200"]["content"]["application/json"];

type GetPrincipalTransactionsQuery =
  paths["/extended/v3/principals/{principal}/transactions"]["get"]["parameters"]["query"];

type GetTransactionEventsQuery =
  paths["/extended/v3/transactions/{tx_id}/events"]["get"]["parameters"]["query"];

export type TransactionEventsResponse =
  paths["/extended/v3/transactions/{tx_id}/events"]["get"]["responses"]["200"]["content"]["application/json"];

/**
 * Minimal transaction shape required for storage.
 * Satisfied by the `GET /extended/v3/transactions/batch` and
 * `GET /extended/v3/blocks/{height_or_hash}/transactions` summaries.
 */
export interface StorableTransaction {
  tx_id: string;
  sender: { address: string; nonce: number };
  fee_rate: string;
  block: { height: number; hash: string; index_hash: string; tx_index: number; time?: number };
  bitcoin_block: { height: number; time: number };
  status: string;
  type: string;
}

/**
 * Minimal block shape required for storage in `blocksTable`.
 * Satisfied by both the full `GET /extended/v2/blocks/{height_or_hash}` response
 * and in-memory extraction from `StorableTransaction` (via `tx.block` and `tx.bitcoin_block`).
 * Allows inserting blocks without making separate block API calls.
 */
export interface StorableBlock {
  height: number;
  hash: string;
  index_block_hash: string;
  burn_block_time: number;
  burn_block_height: number;
}

export type PrincipalTransactionsResponse =
  paths["/extended/v3/principals/{principal}/transactions"]["get"]["responses"]["200"]["content"]["application/json"];

type ContractApiResponse =
  paths["/extended/v3/smart-contracts/{contract_id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractLogsResponse =
  paths["/extended/v2/smart-contracts/{contract_id}/logs"]["get"]["responses"]["200"]["content"]["application/json"];

type ApiStatusResponse =
  paths["/extended"]["get"]["responses"]["200"]["content"]["application/json"];

type V1TransactionApiResponse = Extract<
  paths["/extended/v1/tx/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"],
  { block_height: number }
>;

type MinedV1Transaction = V1TransactionApiResponse;

type ContractEvent = MinedV1Transaction["events"][number];

export type SmartContractLogEvent = Extract<ContractEvent, { event_type: "smart_contract_log" }>;

export interface CallReadResponse {
  okay: boolean;
  result: string;
  cause?: string;
}

interface CallReadBody {
  sender: string;
  arguments: string[];
}

export interface StacksClientConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
}

export interface StacksClientService {
  readonly getStatus: () => Effect.Effect<ApiStatusResponse, StacksHttpError>;
  /** Most recent blocks first (`GET /extended/v2/blocks`). */
  readonly getBlocks: (
    options?: GetBlocksQuery,
  ) => Effect.Effect<BlocksApiResponse, StacksHttpError>;
  readonly getBlock: (
    heightOrHash: string | number,
    options?: GetBlockQuery,
  ) => Effect.Effect<BlockApiResponse, StacksHttpError>;
  readonly getBlockTransactions: (
    heightOrHash: string | number,
    options?: GetBlockTransactionsQuery,
  ) => Effect.Effect<BlockTransactionsApiResponse, StacksHttpError>;
  readonly getV1Transaction: (
    txId: string,
  ) => Effect.Effect<V1TransactionApiResponse, StacksHttpError>;
  readonly getTransactionsBatch: (
    txIds: string[],
  ) => Effect.Effect<TransactionsBatchResponse, StacksHttpError>;
  readonly getTransactionEvents: (
    txId: string,
    options?: GetTransactionEventsQuery,
  ) => Effect.Effect<TransactionEventsResponse, StacksHttpError>;
  readonly getPrincipalTransactions: (
    principal: string,
    options?: GetPrincipalTransactionsQuery,
  ) => Effect.Effect<PrincipalTransactionsResponse, StacksHttpError>;
  readonly getContract: (contractId: string) => Effect.Effect<ContractApiResponse, StacksHttpError>;
  readonly getContractLogs: (
    contractId: string,
    options?: GetContractLogsQuery,
  ) => Effect.Effect<ContractLogsResponse, StacksHttpError>;
  /**
   * Calls a read-only function. `tip` pins the call to a block by its index
   * block hash; the node reads the chain tip when it is omitted.
   */
  readonly callReadFunction: (
    contractId: string,
    functionName: string,
    options?: { args?: string[]; sender?: string; tip?: string },
  ) => Effect.Effect<CallReadResponse, StacksHttpError>;
}

const MAX_RETRIES = 3;

const RETRYABLE_STATUSES = [408, 500, 502, 503, 504];

/**
 * Initial request budget before the limiter learns the real limits from
 * `x-ratelimit-*` response headers and 429 feedback.
 */
const DEFAULT_RATE_LIMIT = {
  limit: 50,
  window: Duration.seconds(1),
};

/**
 * Retries transport failures and transient HTTP statuses. Rate limits (429)
 * are owned by `withRateLimiter`, which honors the `Retry-After` header.
 */
function isRetryable(
  error: HttpClientError.HttpClientError | RateLimiter.RateLimiterError,
): boolean {
  if (!HttpClientError.isHttpClientError(error)) {
    return false;
  }

  if (Predicate.isTagged(error.reason, "TransportError")) {
    return true;
  }

  return (
    Predicate.isTagged(error.reason, "StatusCodeError") &&
    RETRYABLE_STATUSES.includes(error.reason.response.status)
  );
}

const retrySchedule = Schedule.exponential(Duration.millis(500)).pipe(Schedule.jittered);

/** The `StacksClient` method name; URL paths embed tx ids and hashes, so never label by them. */
type Endpoint = keyof StacksClientService;

type ResponseStatus = "2xx" | "3xx" | "4xx" | "429" | "5xx" | "network";

interface EndpointMetrics {
  readonly success: typeof apiRequestDuration;
  readonly failure: typeof apiRequestDuration;
  readonly responses: Readonly<Record<ResponseStatus, typeof apiResponses>>;
}

const endpointMetricsCache = new Map<Endpoint, EndpointMetrics>();

/** Labels an endpoint's series once, keeping attribute building off the request path. */
function endpointMetrics(endpoint: Endpoint): EndpointMetrics {
  const cached = endpointMetricsCache.get(endpoint);

  if (cached !== undefined) {
    return cached;
  }

  const responses = (status: ResponseStatus) =>
    Metric.withAttributes(apiResponses, { endpoint, status });

  const metrics: EndpointMetrics = {
    success: Metric.withAttributes(apiRequestDuration, { endpoint, outcome: "success" }),
    failure: Metric.withAttributes(apiRequestDuration, { endpoint, outcome: "failure" }),
    responses: {
      "2xx": responses("2xx"),
      "3xx": responses("3xx"),
      "4xx": responses("4xx"),
      "429": responses("429"),
      "5xx": responses("5xx"),
      network: responses("network"),
    },
  };

  endpointMetricsCache.set(endpoint, metrics);

  return metrics;
}

/**
 * The calling endpoint's metrics, provided per logical request so the
 * per-attempt counter below the rate limiter can label attempts without
 * touching the outgoing request.
 */
class ApiEndpoint extends Context.Service<ApiEndpoint, EndpointMetrics>()(
  "stacksindex/datasources/StacksClient/ApiEndpoint",
) {}

function responseStatus(status: number): ResponseStatus {
  if (status === 429) {
    return "429";
  }

  if (status >= 500) {
    return "5xx";
  }

  if (status >= 400) {
    return "4xx";
  }

  return status >= 300 ? "3xx" : "2xx";
}

/**
 * Executes a request and trusts the API contract for the response shape.
 * No runtime decoding is performed, keeping the hot path allocation-free.
 */
function execute<A>(
  client: StacksHttpClient,
  endpoint: Endpoint,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<A, StacksHttpError> {
  const path = new URL(request.url).pathname;
  const metrics = endpointMetrics(endpoint);

  return Effect.flatMap(Clock.currentTimeMillis, (startedAt) =>
    client.execute(request).pipe(
      Effect.retry({ schedule: retrySchedule, times: MAX_RETRIES, while: isRetryable }),
      Effect.flatMap((response) => response.json),
      Effect.map(
        (json) =>
          // SAFETY: The endpoint's JSON shape is fixed by the API contract that selected A.
          json as A,
      ),
      // An interrupted request neither succeeded nor failed; leave it out.
      Effect.onExit((exit) =>
        Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)
          ? Effect.void
          : Effect.flatMap(Clock.currentTimeMillis, (endedAt) =>
              Metric.update(
                Exit.isSuccess(exit) ? metrics.success : metrics.failure,
                endedAt - startedAt,
              ),
            ),
      ),
      Effect.provideService(ApiEndpoint, metrics),
    ),
  ).pipe(
    Effect.withSpan("StacksApi.request", {
      attributes: { "http.request.method": request.method, "url.path": path },
    }),
    Effect.annotateLogs({ "stacksapi.path": path, "http.request.method": request.method }),
  );
}

const makeHttpClient = () =>
  Effect.gen(function* () {
    const baseClient = yield* HttpClient.HttpClient;
    const limiter = yield* RateLimiter.RateLimiter;

    // Count every attempt here, below the rate limiter and `execute`'s retry,
    // So retried 429s and transient failures are each counted.
    const countedClient = HttpClient.transformResponse(baseClient, (effect) =>
      Effect.flatMap(Effect.service(ApiEndpoint), ({ responses }) =>
        effect.pipe(
          Effect.tap((response) => Metric.update(responses[responseStatus(response.status)], 1)),
          Effect.tapError((error) =>
            Predicate.isTagged(error.reason, "TransportError")
              ? Metric.update(responses.network, 1)
              : Effect.void,
          ),
        ),
      ),
    );

    return countedClient.pipe(
      // Throttle proactively, learn the budget from `x-ratelimit-*` headers, and
      // Retry rate limits (429) honoring the `Retry-After` header.
      HttpClient.withRateLimiter({
        limiter,
        key: "stacksindex/datasources/StacksClient",
        window: DEFAULT_RATE_LIMIT.window,
        limit: DEFAULT_RATE_LIMIT.limit,
        times: MAX_RETRIES,
      }),
      // Turn non-2xx responses into errors so `isRetryable` sees them.
      HttpClient.filterStatusOk,
    );
  });

type StacksHttpClient = Effect.Success<ReturnType<typeof makeHttpClient>>;

export class StacksClient extends Context.Service<StacksClient, StacksClientService>()(
  "stacksindex/datasources/StacksClient",
) {
  /** Raw constructor; provide `HttpClient` and `RateLimiter`, e.g. mocks in tests. */
  static readonly make = (
    config: StacksClientConfig,
  ): Effect.Effect<StacksClientService, never, HttpClient.HttpClient | RateLimiter.RateLimiter> =>
    Effect.gen(function* () {
      const client = yield* makeHttpClient();
      const headers: Record<string, string> = {};

      if (config.apiKey !== undefined) {
        headers["x-api-key"] = config.apiKey;
      }

      const get = <A>(endpoint: Endpoint, path: string, query?: UrlParams.Input) =>
        execute<A>(
          client,
          endpoint,
          HttpClientRequest.get(`${config.baseUrl}${path}`, {
            urlParams: query,
            headers,
            acceptJson: true,
          }),
        );

      const post = <A>(
        endpoint: Endpoint,
        path: string,
        query: UrlParams.Input | undefined,
        body: CallReadBody,
      ) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${config.baseUrl}${path}`, {
              urlParams: query,
              headers,
              acceptJson: true,
            }),
            body,
          ).pipe(Effect.orDie);

          return yield* execute<A>(client, endpoint, request);
        });

      return StacksClient.of({
        getStatus: () => get<ApiStatusResponse>("getStatus", "/extended"),
        getBlocks: (options) => get<BlocksApiResponse>("getBlocks", "/extended/v2/blocks", options),
        getBlock: (heightOrHash, options) =>
          get<BlockApiResponse>("getBlock", `/extended/v2/blocks/${heightOrHash}`, options),
        getBlockTransactions: (heightOrHash, options) =>
          get<BlockTransactionsApiResponse>(
            "getBlockTransactions",
            `/extended/v3/blocks/${heightOrHash}/transactions`,
            options,
          ),
        getV1Transaction: (txId) =>
          get<V1TransactionApiResponse>("getV1Transaction", `/extended/v1/tx/${txId}`),
        getTransactionsBatch: (txIds) =>
          txIds.length === 0
            ? Effect.succeed<TransactionsBatchResponse>({ results: [] })
            : get<TransactionsBatchResponse>(
                "getTransactionsBatch",
                "/extended/v3/transactions/batch",
                { tx_id: txIds },
              ),
        getTransactionEvents: (txId, options = {}) => {
          const { limit = 50, cursor, ...rest } = options;

          return get<TransactionEventsResponse>(
            "getTransactionEvents",
            `/extended/v3/transactions/${txId}/events`,
            { limit, cursor, ...rest },
          );
        },
        getPrincipalTransactions: (principal, options = {}) => {
          const { limit = 50, cursor, ...rest } = options;

          return get<PrincipalTransactionsResponse>(
            "getPrincipalTransactions",
            `/extended/v3/principals/${principal}/transactions`,
            { limit, cursor, ...rest },
          );
        },
        getContract: (contractId) =>
          get<ContractApiResponse>("getContract", `/extended/v3/smart-contracts/${contractId}`),
        getContractLogs: (contractId, options = {}) => {
          const { limit = 100, cursor, ...rest } = options;

          return get<ContractLogsResponse>(
            "getContractLogs",
            `/extended/v2/smart-contracts/${contractId}/logs`,
            { limit, cursor, ...rest },
          );
        },
        callReadFunction: (contractId, functionName, options = {}) => {
          const { args = [], sender = DEFAULT_SENDER, tip } = options;
          const [contractAddress, contractName] = contractId.split(".");

          const path =
            contractAddress && contractName
              ? `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`
              : `/v2/contracts/call-read/${contractId}/${functionName}`;

          return post<CallReadResponse>(
            "callReadFunction",
            path,
            tip === undefined ? undefined : { tip: tip.replace(/^0x/u, "") },
            { sender, arguments: args },
          );
        },
      });
    });

  /** Self-contained layer using the fetch transport and an in-memory rate limiter. */
  static readonly layer = (config: StacksClientConfig): Layer.Layer<StacksClient> =>
    Layer.effect(StacksClient, StacksClient.make(config)).pipe(
      Layer.provide(
        Layer.mergeAll(
          FetchHttpClient.layer,
          RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory)),
        ),
      ),
    );
}
