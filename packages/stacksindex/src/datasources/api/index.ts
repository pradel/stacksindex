import type { paths } from "@stacks/blockchain-api-client";
import type { ClarityAbi } from "clarity-abitype";
import { Context, Duration, Effect, Layer, Schedule } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

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

interface RequestOptions<QueryT = unknown> {
  path: string;
  method: "GET" | "POST";
  query?: QueryT;
  body?: unknown;
}

export const datasourceStacksApi = {
  _request<ResponseT, QueryT extends Record<string, unknown> | undefined>(
    context: DatasourceStacksApiContext,
    options: RequestOptions<QueryT>,
  ): Effect.Effect<ResponseT, StacksApiError> {
    const { path, method } = options;
    const baseUrl = context.api?.baseUrl ?? "https://api.hiro.so";
    let url = `${baseUrl}${path}`;
    if (options.query) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(options.query)) {
        const vals = Array.isArray(value) ? value : [value];
        for (const entry of vals) {
          if (entry !== null && entry !== undefined) {
            // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-call, typescript/no-unsafe-member-access
            const str: string = typeof entry === "string" ? entry : entry.toString();
            parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(str)}`);
          }
        }
      }
      if (parts.length > 0) {
        url += `?${parts.join("&")}`;
      }
    }

    const singleAttempt = Effect.gen(function* singleAttempt() {
      let req = method === "GET" ? HttpClientRequest.get(url) : HttpClientRequest.post(url);
      if (context.api?.apiKey) {
        req = HttpClientRequest.setHeader(req, "x-api-key", context.api.apiKey);
      }
      if (options.body !== undefined) {
        req = HttpClientRequest.bodyJsonUnsafe(req, options.body);
      }

      const client = yield* HttpClient.HttpClient;
      const res = yield* client.execute(req).pipe(
        Effect.mapError(
          (err) =>
            new StacksApiUnexpectedError({
              message: "Failed to execute HTTP request",
              cause: err,
              path,
            }),
        ),
      );

      if (res.status === 429) {
        const retryAfter = Number(res.headers["retry-after"] ?? 1);
        return yield* new StacksApiRateLimitError({ path, retryAfter });
      }

      if (res.status < 200 || res.status >= 300) {
        const errorData = yield* res.json.pipe(
          Effect.catch(() => res.text),
          Effect.match({
            onSuccess: (data) => data,
            onFailure: () => undefined,
          }),
        );
        const statusText =
          // oxlint-disable-next-line typescript/no-explicit-any, typescript/no-unsafe-member-access
          (res as any).source?.statusText ||
          (res.status === 404
            ? "Not Found"
            : res.status === 400
              ? "Bad Request"
              : res.status === 500
                ? "Internal Server Error"
                : String(res.status));
        return yield* new StacksApiResponseError({
          status: res.status,
          path,
          statusText,
          errorData,
        });
      }

      const data = yield* res.json.pipe(
        Effect.mapError(
          (err) =>
            new StacksApiParseError({
              message: "Failed to parse JSON response",
              cause: err,
            }),
        ),
      );

      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return data as ResponseT;
    });

    // Handle rate limit retries (up to 3 times) and 5xx transient retries (up to 3 times)
    const executeWithRetry = (
      attempt: number,
    ): Effect.Effect<ResponseT, StacksApiError, HttpClient.HttpClient> =>
      singleAttempt.pipe(
        Effect.catchTag("StacksApiRateLimitError", (err) => {
          if (attempt >= 3) {
            return Effect.fail(err);
          }
          const delay = Duration.seconds(err.retryAfter);
          return Effect.logDebug(
            `Rate limited on ${path}, retrying in ${err.retryAfter}s (attempt ${attempt + 1})`,
          ).pipe(
            Effect.andThen(Effect.sleep(delay)),
            Effect.andThen(executeWithRetry(attempt + 1)),
          );
        }),
        Effect.retry({
          schedule: Schedule.exponential(Duration.millis(500)).pipe(Schedule.upTo({ times: 3 })),
          while: (err) =>
            err._tag === "StacksApiResponseError" &&
            (err.status === 500 || err.status === 502 || err.status === 503),
        }),
      );

    return executeWithRetry(0).pipe(Effect.provide(FetchHttpClient.layer));
  },

  getBlock(
    context: DatasourceStacksApiContext,
    heightOrHash: string | number,
    options?: GetBlockQuery,
  ): Effect.Effect<BlockApiResponse, StacksApiError> {
    return this._request<BlockApiResponse, GetBlockQuery>(context, {
      path: `/extended/v2/blocks/${heightOrHash}`,
      method: "GET",
      query: options,
    });
  },

  getBlockTransactions(
    context: DatasourceStacksApiContext,
    heightOrHash: string | number,
    options: GetBlockTransactionsQuery = {},
  ): Effect.Effect<BlockTransactionsApiResponse, StacksApiError> {
    return this._request<BlockTransactionsApiResponse, GetBlockTransactionsQuery>(context, {
      path: `/extended/v3/blocks/${heightOrHash}/transactions`,
      method: "GET",
      query: options,
    });
  },

  getTransaction(
    context: DatasourceStacksApiContext,
    txId: string,
    options: GetTransactionQuery = {},
  ): Effect.Effect<TransactionApiResponse, StacksApiError> {
    const { include } = options;
    return this._request<TransactionApiResponse, { include?: string | null }>(context, {
      path: `/extended/v3/transactions/${txId}`,
      method: "GET",
      query: { include: include && include.length > 0 ? include.join(",") : null },
    });
  },

  getV1Transaction(
    context: DatasourceStacksApiContext,
    txId: string,
  ): Effect.Effect<V1TransactionApiResponse, StacksApiError> {
    return this._request<V1TransactionApiResponse, undefined>(context, {
      path: `/extended/v1/tx/${txId}`,
      method: "GET",
    });
  },

  getTransactionsBatch(
    context: DatasourceStacksApiContext,
    txIds: string[],
  ): Effect.Effect<TransactionsBatchResponse, StacksApiError> {
    if (txIds.length === 0) {
      return Effect.succeed({ results: [] });
    }
    return this._request<TransactionsBatchResponse, GetTransactionsBatchQuery>(context, {
      path: "/extended/v3/transactions/batch",
      method: "GET",
      query: { tx_id: txIds },
    });
  },

  getTransactionEvents(
    context: DatasourceStacksApiContext,
    txId: string,
    options: GetTransactionEventsQuery = {},
  ): Effect.Effect<TransactionEventsResponse, StacksApiError> {
    const { limit = 50, cursor, ...rest } = options;
    const path = `/extended/v3/transactions/${txId}/events`;
    return this._request<TransactionEventsResponse, GetTransactionEventsQuery>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  getPrincipalTransactions(
    context: DatasourceStacksApiContext,
    principal: string,
    options: GetPrincipalTransactionsQuery = {},
  ): Effect.Effect<PrincipalTransactionsResponse, StacksApiError> {
    const { limit = 50, cursor, ...rest } = options;
    const path = `/extended/v3/principals/${principal}/transactions`;
    return this._request<PrincipalTransactionsResponse, GetPrincipalTransactionsQuery>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  getContract(
    context: DatasourceStacksApiContext,
    contractId: string,
  ): Effect.Effect<ContractApiResponse, StacksApiError> {
    const path = `/extended/v3/smart-contracts/${contractId}`;
    return this._request<ContractApiResponse, undefined>(context, {
      path,
      method: "GET",
    });
  },

  getContractLogs(
    context: DatasourceStacksApiContext,
    contractId: string,
    options: GetContractLogsQuery = {},
  ): Effect.Effect<ContractLogsResponse, StacksApiError> {
    const { limit = 100, cursor, ...rest } = options;
    const path = `/extended/v2/smart-contracts/${contractId}/logs`;
    return this._request<ContractLogsResponse, GetContractLogsQuery>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  getStatus(context: DatasourceStacksApiContext): Effect.Effect<ApiStatusResponse, StacksApiError> {
    return this._request<ApiStatusResponse, undefined>(context, {
      path: "/extended",
      method: "GET",
    });
  },

  callReadFunction(
    context: DatasourceStacksApiContext,
    contractId: string,
    functionName: string,
    options: { args?: string[]; sender?: string; tip?: number } = {},
  ): Effect.Effect<CallReadResponse, StacksApiError> {
    const { args = [], sender = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", tip } = options;
    const [contractAddress, contractName] = contractId.split(".");
    const path =
      contractAddress && contractName
        ? `/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`
        : `/v2/contracts/call-read/${contractId}/${functionName}`;
    return this._request<CallReadResponse, { tip?: number | null }>(context, {
      path,
      method: "POST",
      query: { tip: tip ?? null },
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
  ): Effect.Effect<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError> {
    return (typedCallReadFunction as any)(
      context,
      (ctx: any, cId: any, fn: any, opts: any) => this.callReadFunction(ctx, cId, fn, opts),
      parameters,
    ) as Effect.Effect<TypedCallReadOnlyFunctionReturnType<TAbi, TFunctionName>, StacksApiError>;
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
      const ctx: DatasourceStacksApiContext = {
        api: { baseUrl: config.baseUrl, apiKey: config.apiKey },
      };
      return StacksClient.of({
        getStatus: datasourceStacksApi.getStatus(ctx),
        getContract: (cId) => datasourceStacksApi.getContract(ctx, cId),
        getPrincipalTransactions: (p, opts) =>
          datasourceStacksApi.getPrincipalTransactions(ctx, p, opts),
        getTransactionEvents: (t, opts) => datasourceStacksApi.getTransactionEvents(ctx, t, opts),
        getContractLogs: (cId, opts) => datasourceStacksApi.getContractLogs(ctx, cId, opts),
        getTransactionsBatch: (ids) => datasourceStacksApi.getTransactionsBatch(ctx, ids),
        callReadFunction: (cId, fn, opts) =>
          datasourceStacksApi.callReadFunction(ctx, cId, fn, opts),
      });
    }),
  );
}
