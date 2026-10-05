import type { paths } from "@stacks/blockchain-api-client";
import { Context, Duration, Effect, Layer, Predicate, Schedule } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  type UrlParams,
} from "effect/http";
import { RateLimiter } from "effect/persistence";

import type { StacksApiError } from "./errors.ts";

export { readOnly } from "./read-only.ts";

export type {
  CallReadFunction,
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
} from "./read-only.ts";

export type BlockApiResponse =
  paths["/extended/v2/blocks/{height_or_hash}"]["get"]["responses"]["200"]["content"]["application/json"];

export type GetBlockQuery =
  paths["/extended/v2/blocks/{height_or_hash}"]["get"]["parameters"]["query"];

export type BlockTransactionsApiResponse =
  paths["/extended/v3/blocks/{height_or_hash}/transactions"]["get"]["responses"]["200"]["content"]["application/json"];

export type GetBlockTransactionsQuery =
  paths["/extended/v3/blocks/{height_or_hash}/transactions"]["get"]["parameters"]["query"];

export type GetContractLogsQuery =
  paths["/extended/v2/smart-contracts/{contract_id}/logs"]["get"]["parameters"]["query"];

export type GetTransactionQuery =
  paths["/extended/v3/transactions/{tx_id}"]["get"]["parameters"]["query"];

export type GetTransactionsBatchQuery =
  paths["/extended/v3/transactions/batch"]["get"]["parameters"]["query"];

export type TransactionsBatchResponse =
  paths["/extended/v3/transactions/batch"]["get"]["responses"]["200"]["content"]["application/json"];

export type TransactionSummary = TransactionsBatchResponse["results"][number];

export type GetPrincipalTransactionsQuery =
  paths["/extended/v3/principals/{principal}/transactions"]["get"]["parameters"]["query"];

export type GetTransactionEventsQuery =
  paths["/extended/v3/transactions/{tx_id}/events"]["get"]["parameters"]["query"];

export type TransactionEventsResponse =
  paths["/extended/v3/transactions/{tx_id}/events"]["get"]["responses"]["200"]["content"]["application/json"];

export type TransactionEvent = TransactionEventsResponse["results"][number];

export type TransactionApiResponse = Extract<
  paths["/extended/v3/transactions/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"],
  { block: unknown }
>;

/**
 * Minimal transaction shape required for storage.
 * Satisfied by both the full `GET /extended/v3/transactions/{tx_id}` response
 * and the `GET /extended/v3/transactions/batch` summaries.
 */
export interface StorableTransaction {
  tx_id: string;
  sender: { address: string; nonce: number };
  fee_rate: string;
  block: { height: number; hash: string; tx_index: number; time?: number };
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
  burn_block_time: number;
  burn_block_height: number;
}

export type PrincipalTransactionsResponse =
  paths["/extended/v3/principals/{principal}/transactions"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractApiResponse =
  paths["/extended/v3/smart-contracts/{contract_id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractLogsResponse =
  paths["/extended/v2/smart-contracts/{contract_id}/logs"]["get"]["responses"]["200"]["content"]["application/json"];

export type ApiStatusResponse =
  paths["/extended"]["get"]["responses"]["200"]["content"]["application/json"];

export type V1TransactionApiResponse = Extract<
  paths["/extended/v1/tx/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"],
  { block_height: number }
>;

type MinedV1Transaction = V1TransactionApiResponse;

export type ContractEvent = MinedV1Transaction["events"][number];

export type SmartContractLogEvent = Extract<ContractEvent, { event_type: "smart_contract_log" }>;

export type StxLockEvent = Extract<ContractEvent, { event_type: "stx_lock" }>;

export type StxAssetEvent = Extract<ContractEvent, { event_type: "stx_asset" }>;

export type FungibleTokenAssetEvent = Extract<
  ContractEvent,
  { event_type: "fungible_token_asset" }
>;

export type NonFungibleTokenAssetEvent = Extract<
  ContractEvent,
  { event_type: "non_fungible_token_asset" }
>;

export interface CallReadResponse {
  okay: boolean;
  result: string;
  cause?: string;
}

export interface CallReadBody {
  sender: string;
  arguments: string[];
}

export interface StacksClientConfig {
  readonly baseUrl: string;
  readonly apiKey?: string | undefined;
}

export interface StacksClientService {
  readonly getStatus: () => Effect.Effect<ApiStatusResponse, StacksApiError>;
  readonly getBlock: (
    heightOrHash: string | number,
    options?: GetBlockQuery,
  ) => Effect.Effect<BlockApiResponse, StacksApiError>;
  readonly getBlockTransactions: (
    heightOrHash: string | number,
    options?: GetBlockTransactionsQuery,
  ) => Effect.Effect<BlockTransactionsApiResponse, StacksApiError>;
  readonly getTransaction: (
    txId: string,
    options?: GetTransactionQuery,
  ) => Effect.Effect<TransactionApiResponse, StacksApiError>;
  readonly getV1Transaction: (
    txId: string,
  ) => Effect.Effect<V1TransactionApiResponse, StacksApiError>;
  readonly getTransactionsBatch: (
    txIds: string[],
  ) => Effect.Effect<TransactionsBatchResponse, StacksApiError>;
  readonly getTransactionEvents: (
    txId: string,
    options?: GetTransactionEventsQuery,
  ) => Effect.Effect<TransactionEventsResponse, StacksApiError>;
  readonly getPrincipalTransactions: (
    principal: string,
    options?: GetPrincipalTransactionsQuery,
  ) => Effect.Effect<PrincipalTransactionsResponse, StacksApiError>;
  readonly getContract: (contractId: string) => Effect.Effect<ContractApiResponse, StacksApiError>;
  readonly getContractLogs: (
    contractId: string,
    options?: GetContractLogsQuery,
  ) => Effect.Effect<ContractLogsResponse, StacksApiError>;
  readonly callReadFunction: (
    contractId: string,
    functionName: string,
    options?: { args?: string[]; sender?: string; tip?: number },
  ) => Effect.Effect<CallReadResponse, StacksApiError>;
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

const DEFAULT_SENDER = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM";

/**
 * Retries transport failures and transient HTTP statuses. Rate limits (429)
 * are owned by `withRateLimiter`, which honors the `Retry-After` header.
 */
function isRetryable(
  error: HttpClientError.HttpClientError | RateLimiter.RateLimiterError,
): boolean {
  if (!Predicate.isTagged(error, "HttpClientError")) {
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

/**
 * Executes a request and trusts the API contract for the response shape.
 * No runtime decoding is performed, keeping the hot path allocation-free.
 */
function execute<A>(
  client: StacksHttpClient,
  request: HttpClientRequest.HttpClientRequest,
  path: string,
): Effect.Effect<A, StacksApiError> {
  return client.execute(request).pipe(
    Effect.retry({ schedule: retrySchedule, times: MAX_RETRIES, while: isRetryable }),
    Effect.flatMap((response) => response.json),
    Effect.map(
      (json) =>
        // SAFETY: The endpoint's JSON shape is fixed by the API contract that selected A.
        json as A,
    ),
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

    return baseClient.pipe(
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

      const get = <A>(path: string, query?: UrlParams.Input) =>
        execute<A>(
          client,
          HttpClientRequest.get(`${config.baseUrl}${path}`, {
            urlParams: query,
            headers,
            acceptJson: true,
          }),
          path,
        );

      const post = <A>(path: string, query: UrlParams.Input | undefined, body: CallReadBody) =>
        Effect.gen(function* () {
          const request = yield* HttpClientRequest.bodyJson(
            HttpClientRequest.post(`${config.baseUrl}${path}`, {
              urlParams: query,
              headers,
              acceptJson: true,
            }),
            body,
          ).pipe(Effect.orDie);

          return yield* execute<A>(client, request, path);
        });

      return StacksClient.of({
        getStatus: () => get<ApiStatusResponse>("/extended"),
        getBlock: (heightOrHash, options) =>
          get<BlockApiResponse>(`/extended/v2/blocks/${heightOrHash}`, options),
        getBlockTransactions: (heightOrHash, options) =>
          get<BlockTransactionsApiResponse>(
            `/extended/v3/blocks/${heightOrHash}/transactions`,
            options,
          ),
        getTransaction: (txId, options = {}) => {
          const { include } = options;

          const query =
            include !== null && include !== undefined && include.length > 0
              ? { include: include.join(",") }
              : undefined;

          return get<TransactionApiResponse>(`/extended/v3/transactions/${txId}`, query);
        },
        getV1Transaction: (txId) => get<V1TransactionApiResponse>(`/extended/v1/tx/${txId}`),
        getTransactionsBatch: (txIds) =>
          txIds.length === 0
            ? Effect.succeed<TransactionsBatchResponse>({ results: [] })
            : get<TransactionsBatchResponse>("/extended/v3/transactions/batch", {
                tx_id: txIds,
              }),
        getTransactionEvents: (txId, options = {}) => {
          const { limit = 50, cursor, ...rest } = options;

          return get<TransactionEventsResponse>(`/extended/v3/transactions/${txId}/events`, {
            limit,
            cursor,
            ...rest,
          });
        },
        getPrincipalTransactions: (principal, options = {}) => {
          const { limit = 50, cursor, ...rest } = options;

          return get<PrincipalTransactionsResponse>(
            `/extended/v3/principals/${principal}/transactions`,
            { limit, cursor, ...rest },
          );
        },
        getContract: (contractId) =>
          get<ContractApiResponse>(`/extended/v3/smart-contracts/${contractId}`),
        getContractLogs: (contractId, options = {}) => {
          const { limit = 100, cursor, ...rest } = options;

          return get<ContractLogsResponse>(`/extended/v2/smart-contracts/${contractId}/logs`, {
            limit,
            cursor,
            ...rest,
          });
        },
        callReadFunction: (contractId, functionName, options = {}) => {
          const { args = [], sender = DEFAULT_SENDER, tip } = options;
          const [contractAddress, contractName] = contractId.split(".");

          const path =
            contractAddress && contractName
              ? `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`
              : `/v2/contracts/call-read/${contractId}/${functionName}`;

          return post<CallReadResponse>(path, tip === undefined ? undefined : { tip }, {
            sender,
            arguments: args,
          });
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
