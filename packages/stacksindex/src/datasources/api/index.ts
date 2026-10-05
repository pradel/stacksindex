import type { paths } from "@stacks/blockchain-api-client";
import type { ClarityAbi } from "clarity-abitype";
import { Context, Duration, Effect, Layer, Match, Predicate, Schedule } from "effect";
import {
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
  type UrlParams,
} from "effect/http";

import type { Logger } from "../../logger/index.ts";
import {
  type StacksApiError,
  StacksApiParseError,
  StacksApiRateLimitError,
  StacksApiResponseError,
  StacksApiUnexpectedError,
} from "./errors.ts";
import {
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  typedCallReadFunction,
  type TypedCallReadOnlyFunctionParameters,
  type TypedCallReadOnlyFunctionReturnType,
  type UntypedCallReadOnlyFunctionParameters,
} from "./read-only.ts";

export type {
  ContractFunctionArgs,
  ContractFunctionName,
  ContractFunctionReturnType,
  TypedCallReadOnlyFunctionParameters,
  TypedCallReadOnlyFunctionReturnType,
  UntypedCallReadOnlyFunctionParameters,
};

export { typedCallReadFunction };

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

export interface DatasourceStacksApiContext {
  logger?: Logger;
  api?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export interface CallReadResponse {
  okay: boolean;
  result: string;
  cause?: string;
}

interface RequestOptions {
  path: string;
  method: "GET" | "POST";
  query?: UrlParams.Input | undefined;
  body?: unknown;
}

const MAX_RETRIES = 3;

function statusTextFor(status: number): string {
  return Match.value(status).pipe(
    Match.when(400, () => "Bad Request"),
    Match.when(404, () => "Not Found"),
    Match.when(500, () => "Internal Server Error"),
    Match.orElse(() => String(status)),
  );
}

function readErrorData(response: HttpClientResponse.HttpClientResponse): Effect.Effect<unknown> {
  return response.text.pipe(
    Effect.map((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }),
    Effect.catch(() => Effect.succeed(undefined)),
  );
}

const exponentialBackoff: Schedule.Schedule<Duration.Duration, StacksApiError> =
  Schedule.exponential(Duration.millis(500));

const retrySchedule = exponentialBackoff.pipe(
  Schedule.jittered,
  Schedule.modifyDelay(({ duration, input }) =>
    Predicate.isTagged(input, "StacksApiRateLimitError")
      ? Effect.succeed(Duration.seconds(input.retryAfter))
      : Effect.succeed(duration),
  ),
);

function isRetryable(error: StacksApiError): boolean {
  return (
    Predicate.isTagged(error, "StacksApiRateLimitError") ||
    (Predicate.isTagged(error, "StacksApiResponseError") &&
      (error.status === 500 || error.status === 502 || error.status === 503))
  );
}

const DEFAULT_RETRY_AFTER_SECONDS = 1;

const MAX_RETRY_AFTER_SECONDS = 300;

/**
 * Parses a `Retry-After` header, which may be seconds or an HTTP date.
 * Falls back to one second when missing, invalid, or already past.
 */
function parseRetryAfter(header: string | undefined, now: number = Date.now()): number {
  const value = header?.trim();

  if (!value) {
    return DEFAULT_RETRY_AFTER_SECONDS;
  }

  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
  }

  const date = Date.parse(value);

  if (!Number.isNaN(date)) {
    const secondsUntilRetry = Math.ceil((date - now) / 1000);

    if (secondsUntilRetry > 0) {
      return Math.min(secondsUntilRetry, MAX_RETRY_AFTER_SECONDS);
    }
  }

  return DEFAULT_RETRY_AFTER_SECONDS;
}

export const datasourceStacksApi = {
  _request<ResponseT>(
    context: DatasourceStacksApiContext,
    options: RequestOptions,
  ): Effect.Effect<ResponseT, StacksApiError, HttpClient.HttpClient> {
    const { path, method } = options;
    const baseUrl = context.api?.baseUrl ?? "https://api.hiro.so";
    const url = `${baseUrl}${path}`;
    const apiKey = context.api?.apiKey;
    const headers: Record<string, string> = {};

    if (apiKey !== undefined) {
      headers["x-api-key"] = apiKey;
    }

    const attempt = Effect.gen(function* singleAttempt() {
      const client = yield* HttpClient.HttpClient;

      const baseRequest = HttpClientRequest.make(method)(url, {
        urlParams: options.query,
        headers,
        acceptJson: true,
      });

      const request =
        options.body === undefined
          ? baseRequest
          : yield* HttpClientRequest.bodyJson(baseRequest, options.body).pipe(
              Effect.mapError(
                (err) =>
                  new StacksApiUnexpectedError({
                    message: "Failed to encode HTTP request body",
                    cause: err,
                    path,
                  }),
              ),
            );

      const response = yield* client.execute(request).pipe(
        Effect.mapError(
          (err) =>
            new StacksApiUnexpectedError({
              message: "Failed to execute HTTP request",
              cause: err,
              path,
            }),
        ),
      );

      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers["retry-after"]);

        return yield* new StacksApiRateLimitError({ path, retryAfter });
      }

      if (response.status < 200 || response.status >= 300) {
        const errorData = yield* readErrorData(response);

        return yield* new StacksApiResponseError({
          status: response.status,
          path,
          statusText: statusTextFor(response.status),
          errorData,
        });
      }

      const text = yield* response.text.pipe(
        Effect.mapError(
          (err) =>
            new StacksApiUnexpectedError({
              message: "Failed to read HTTP response body",
              cause: err,
              path,
            }),
        ),
      );

      return yield* Effect.try({
        try: () =>
          // SAFETY: The endpoint's JSON shape is fixed by the same API contract that selected ResponseT.
          JSON.parse(text) as ResponseT,
        catch: (err) =>
          new StacksApiParseError({ message: "Failed to parse JSON response", cause: err }),
      });
    });

    return attempt.pipe(
      Effect.retry({
        schedule: retrySchedule,
        times: MAX_RETRIES,
        while: isRetryable,
      }),
    );
  },

  getBlock(
    context: DatasourceStacksApiContext,
    heightOrHash: string | number,
    options?: GetBlockQuery,
  ): Effect.Effect<BlockApiResponse, StacksApiError, HttpClient.HttpClient> {
    return this._request<BlockApiResponse>(context, {
      path: `/extended/v2/blocks/${heightOrHash}`,
      method: "GET",
      query: options,
    });
  },

  getBlockTransactions(
    context: DatasourceStacksApiContext,
    heightOrHash: string | number,
    options: GetBlockTransactionsQuery = {},
  ): Effect.Effect<BlockTransactionsApiResponse, StacksApiError, HttpClient.HttpClient> {
    return this._request<BlockTransactionsApiResponse>(context, {
      path: `/extended/v3/blocks/${heightOrHash}/transactions`,
      method: "GET",
      query: options,
    });
  },

  getTransaction(
    context: DatasourceStacksApiContext,
    txId: string,
    options: GetTransactionQuery = {},
  ): Effect.Effect<TransactionApiResponse, StacksApiError, HttpClient.HttpClient> {
    const { include } = options;

    const query =
      include !== null && include !== undefined && include.length > 0
        ? { include: include.join(",") }
        : undefined;

    return this._request<TransactionApiResponse>(context, {
      path: `/extended/v3/transactions/${txId}`,
      method: "GET",
      query,
    });
  },

  getV1Transaction(
    context: DatasourceStacksApiContext,
    txId: string,
  ): Effect.Effect<V1TransactionApiResponse, StacksApiError, HttpClient.HttpClient> {
    return this._request<V1TransactionApiResponse>(context, {
      path: `/extended/v1/tx/${txId}`,
      method: "GET",
    });
  },

  getTransactionsBatch(
    context: DatasourceStacksApiContext,
    txIds: string[],
  ): Effect.Effect<TransactionsBatchResponse, StacksApiError, HttpClient.HttpClient> {
    if (txIds.length === 0) {
      return Effect.succeed({ results: [] });
    }

    return this._request<TransactionsBatchResponse>(context, {
      path: "/extended/v3/transactions/batch",
      method: "GET",
      query: { tx_id: txIds },
    });
  },

  getTransactionEvents(
    context: DatasourceStacksApiContext,
    txId: string,
    options: GetTransactionEventsQuery = {},
  ): Effect.Effect<TransactionEventsResponse, StacksApiError, HttpClient.HttpClient> {
    const { limit = 50, cursor, ...rest } = options;
    const path = `/extended/v3/transactions/${txId}/events`;

    return this._request<TransactionEventsResponse>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  getPrincipalTransactions(
    context: DatasourceStacksApiContext,
    principal: string,
    options: GetPrincipalTransactionsQuery = {},
  ): Effect.Effect<PrincipalTransactionsResponse, StacksApiError, HttpClient.HttpClient> {
    const { limit = 50, cursor, ...rest } = options;
    const path = `/extended/v3/principals/${principal}/transactions`;

    return this._request<PrincipalTransactionsResponse>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  getContract(
    context: DatasourceStacksApiContext,
    contractId: string,
  ): Effect.Effect<ContractApiResponse, StacksApiError, HttpClient.HttpClient> {
    const path = `/extended/v3/smart-contracts/${contractId}`;

    return this._request<ContractApiResponse>(context, {
      path,
      method: "GET",
    });
  },

  getContractLogs(
    context: DatasourceStacksApiContext,
    contractId: string,
    options: GetContractLogsQuery = {},
  ): Effect.Effect<ContractLogsResponse, StacksApiError, HttpClient.HttpClient> {
    const { limit = 100, cursor, ...rest } = options;
    const path = `/extended/v2/smart-contracts/${contractId}/logs`;

    return this._request<ContractLogsResponse>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  getStatus(
    context: DatasourceStacksApiContext,
  ): Effect.Effect<ApiStatusResponse, StacksApiError, HttpClient.HttpClient> {
    return this._request<ApiStatusResponse>(context, {
      path: "/extended",
      method: "GET",
    });
  },

  callReadFunction(
    context: DatasourceStacksApiContext,
    contractId: string,
    functionName: string,
    options: { args?: string[]; sender?: string; tip?: number } = {},
  ): Effect.Effect<CallReadResponse, StacksApiError, HttpClient.HttpClient> {
    const { args = [], sender = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", tip } = options;
    const [contractAddress, contractName] = contractId.split(".");

    const path =
      contractAddress && contractName
        ? `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`
        : `/v2/contracts/call-read/${contractId}/${functionName}`;

    return this._request<CallReadResponse>(context, {
      path,
      method: "POST",
      query: tip === undefined ? undefined : { tip },
      body: {
        sender,
        arguments: args,
      },
    });
  },

  typedCallReadFunction<
    const TAbi extends ClarityAbi | readonly unknown[],
    TFunctionName extends ContractFunctionName<TAbi, "read_only">,
    const TArgs extends ContractFunctionArgs<TAbi, "read_only", TFunctionName>,
  >(
    context: DatasourceStacksApiContext,
    parameters: TypedCallReadOnlyFunctionParameters<TAbi, TFunctionName, TArgs>,
  ): Effect.Effect<
    TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>,
    StacksApiError,
    HttpClient.HttpClient
  > {
    return typedCallReadFunction<TAbi, TFunctionName, TArgs, HttpClient.HttpClient>(
      context,
      (ctx, contractId, functionName, options) =>
        this.callReadFunction(ctx, contractId, functionName, options),
      parameters,
    );
  },
};

export class StacksClientConfig extends Context.Service<
  StacksClientConfig,
  {
    readonly baseUrl: string;
    readonly apiKey?: string;
  }
>()("stacksindex/datasources/StacksClientConfig") {}

export class StacksClient extends Context.Service<
  StacksClient,
  {
    readonly getStatus: Effect.Effect<ApiStatusResponse, StacksApiError>;
    readonly getContract: (
      contractId: string,
    ) => Effect.Effect<ContractApiResponse, StacksApiError>;
    readonly getPrincipalTransactions: (
      principal: string,
      options?: GetPrincipalTransactionsQuery,
    ) => Effect.Effect<PrincipalTransactionsResponse, StacksApiError>;
    readonly getTransactionEvents: (
      txId: string,
      options?: GetTransactionEventsQuery,
    ) => Effect.Effect<TransactionEventsResponse, StacksApiError>;
    readonly getContractLogs: (
      contractId: string,
      options?: GetContractLogsQuery,
    ) => Effect.Effect<ContractLogsResponse, StacksApiError>;
    readonly getTransactionsBatch: (
      txIds: string[],
    ) => Effect.Effect<TransactionsBatchResponse, StacksApiError>;
    readonly callReadFunction: (
      contractId: string,
      functionName: string,
      options?: { args?: string[]; sender?: string; tip?: number },
    ) => Effect.Effect<CallReadResponse, StacksApiError>;
  }
>()("stacksindex/datasources/StacksClient") {
  static readonly layer = Layer.effect(
    StacksClient,
    Effect.gen(function* layer() {
      const config = yield* StacksClientConfig;
      const httpClient = yield* HttpClient.HttpClient;

      const ctx: DatasourceStacksApiContext = {
        api: { baseUrl: config.baseUrl, apiKey: config.apiKey },
      };

      const provideClient = <A, E>(
        effect: Effect.Effect<A, E, HttpClient.HttpClient>,
      ): Effect.Effect<A, E> =>
        effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

      return StacksClient.of({
        getStatus: provideClient(datasourceStacksApi.getStatus(ctx)),
        getContract: (cId) => provideClient(datasourceStacksApi.getContract(ctx, cId)),
        getPrincipalTransactions: (p, opts) =>
          provideClient(datasourceStacksApi.getPrincipalTransactions(ctx, p, opts)),
        getTransactionEvents: (t, opts) =>
          provideClient(datasourceStacksApi.getTransactionEvents(ctx, t, opts)),
        getContractLogs: (cId, opts) =>
          provideClient(datasourceStacksApi.getContractLogs(ctx, cId, opts)),
        getTransactionsBatch: (ids) =>
          provideClient(datasourceStacksApi.getTransactionsBatch(ctx, ids)),
        callReadFunction: (cId, fn, opts) =>
          provideClient(datasourceStacksApi.callReadFunction(ctx, cId, fn, opts)),
      });
    }),
  );
}
