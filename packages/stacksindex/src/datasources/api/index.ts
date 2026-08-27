import type { paths } from "@stacks/blockchain-api-client";
import { Result } from "better-result";
import { request } from "undici";

import { sleep, startClock } from "../../lib/timer.ts";
import type { Logger } from "../../logger/index.ts";
import {
  type StacksApiError,
  StacksApiParseError,
  StacksApiRateLimitError,
  StacksApiResponseError,
  StacksApiUnexpectedError,
} from "./errors.ts";

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

export type GetTransactionsQuery = paths["/extended/v1/tx/multiple"]["get"]["parameters"]["query"];

export type GetPrincipalTransactionsQuery =
  paths["/extended/v3/principals/{principal}/transactions"]["get"]["parameters"]["query"];

export type TransactionApiResponse = Extract<
  paths["/extended/v3/transactions/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"],
  { block: unknown }
> & {
  events?: ContractEvent[];
  canonical?: boolean;
};

export type BatchTransactionResult =
  | { found: true; result: TransactionApiResponse }
  | { found: false; tx_id?: string; result?: { tx_id: string } };

export type PrincipalTransactionsResponse =
  paths["/extended/v3/principals/{principal}/transactions"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractApiResponse =
  paths["/extended/v1/contract/{contract_id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractLogsResponse =
  paths["/extended/v2/smart-contracts/{contract_id}/logs"]["get"]["responses"]["200"]["content"]["application/json"];

type MinedV1Transaction = Extract<
  paths["/extended/v1/tx/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"],
  { block_height: number }
>;

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
  logger: Logger;
  api?: {
    baseUrl?: string;
    apiKey?: string;
  };
}

export interface CallReadResponse {
  okay: boolean;
  result: string;
}

interface RequestOptions<QueryT = unknown> {
  path: string;
  method: "GET" | "POST";
  query?: QueryT;
  body?: unknown;
}

export const datasourceStacksApi = {
  async _request<ResponseT, QueryT extends Record<string, unknown> | undefined>(
    context: DatasourceStacksApiContext,
    options: RequestOptions<QueryT>,
  ): Promise<Result<ResponseT, StacksApiError>> {
    return this._requestWithRetry<ResponseT, QueryT>(context, options, 0);
  },

  async _requestWithRetry<ResponseT, QueryT extends Record<string, unknown> | undefined>(
    context: DatasourceStacksApiContext,
    options: RequestOptions<QueryT>,
    attempt: number,
  ): Promise<Result<ResponseT, StacksApiError>> {
    const maxRateLimitRetries = 3;
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

    const result = await Result.tryPromise(
      {
        try: async () => {
          const stopClock = startClock();
          context.logger.trace({
            service: "datasourceStacksApi",
            msg: `${method} ${path} request`,
          });

          const requestInit: Record<string, unknown> = { method };
          const requestHeaders: Record<string, string> = {};
          if (context.api?.apiKey) {
            requestHeaders["x-api-key"] = context.api.apiKey;
          }
          if (options.body !== undefined) {
            requestHeaders["content-type"] = "application/json";
            requestInit.body = JSON.stringify(options.body);
          }
          requestInit.headers = requestHeaders;

          const { statusCode, statusText, body, headers } = await request(url, requestInit);

          let duration = stopClock();
          if (duration > 15000) {
            context.logger.warn({
              service: "datasourceStacksApi",
              msg: `Slow API call ${path}`,
              duration,
            });
          }

          if (statusCode !== 200) {
            // oxlint-disable-next-line init-declarations
            let errorData: unknown;
            const contentType = headers["content-type"] ?? "";
            if (contentType.includes("application/json")) {
              errorData = await body.json().catch(() => body.text().catch(() => null));
            } else {
              errorData = await body.text().catch(() => null);
            }

            duration = stopClock();
            context.logger.trace({
              service: "datasourceStacksApi",
              msg: `${path} error response ${statusCode}`,
              duration,
            });

            if (statusCode === 429) {
              const retryAfter = Number(headers["retry-after"] ?? 1);
              throw new StacksApiRateLimitError({ path, retryAfter });
            }

            throw new StacksApiResponseError({ status: statusCode, path, statusText, errorData });
          }

          try {
            const data = await body.json();

            duration = stopClock();
            context.logger.trace({
              service: "datasourceStacksApi",
              msg: `${path} response`,
              duration,
            });

            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return data as ResponseT;
          } catch (error) {
            throw new StacksApiParseError({
              message: error instanceof Error ? error.message : String(error),
              cause: error,
            });
          }
        },
        catch: (error) =>
          StacksApiResponseError.is(error) ||
          StacksApiRateLimitError.is(error) ||
          StacksApiParseError.is(error)
            ? error
            : new StacksApiUnexpectedError({
                message: "Unexpected Stacks API error",
                cause: error,
                path,
              }),
      },
      {
        retry: {
          times: 3,
          delayMs: 1000,
          backoff: "exponential",
          shouldRetry: (error) =>
            StacksApiResponseError.is(error) &&
            (error.status === 500 || error.status === 502 || error.status === 503),
        },
      },
    );

    if (result.isOk()) {
      return result;
    }

    if (StacksApiRateLimitError.is(result.error) && attempt < maxRateLimitRetries) {
      const delayMs = result.error.retryAfter * 1000;
      context.logger.debug({
        service: "datasourceStacksApi",
        msg: `${path} rate limited, retrying after ${result.error.retryAfter}s, attempt ${attempt + 1}`,
      });
      await sleep(delayMs);
      return this._requestWithRetry(context, options, attempt + 1);
    }

    return result;
  },

  getBlock(
    context: DatasourceStacksApiContext,
    heightOrHash: string | number,
    options?: GetBlockQuery,
  ) {
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
  ) {
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
  ) {
    const { include } = options;
    return this._request<TransactionApiResponse, { include?: string | null }>(context, {
      path: `/extended/v3/transactions/${txId}`,
      method: "GET",
      query: { include: include && include.length > 0 ? include.join(",") : null },
    });
  },

  async getTransactions(
    context: DatasourceStacksApiContext,
    txIds: string[],
    options: GetTransactionsQuery = { tx_id: txIds },
  ): Promise<Result<TransactionApiResponse[], StacksApiError>> {
    if (txIds.length === 0) {
      return Result.ok([]);
    }

    const mapResult = await this._request<
      Record<string, BatchTransactionResult>,
      GetTransactionsQuery
    >(context, {
      path: "/extended/v1/tx/multiple",
      method: "GET",
      query: options,
    });
    if (mapResult.isErr()) {
      return Result.err(mapResult.error);
    }

    const results = txIds
      .map((txId) => {
        const entry = mapResult.value[txId];
        if (entry.found) {
          return entry.result;
        }
        return null;
      })
      .filter((entry): entry is TransactionApiResponse => entry !== null);

    return Result.ok(results);
  },

  getPrincipalTransactions(
    context: DatasourceStacksApiContext,
    principal: string,
    options: GetPrincipalTransactionsQuery = {},
  ) {
    const { limit = 50, cursor, ...rest } = options;
    const path = `/extended/v3/principals/${principal}/transactions`;
    return this._request<PrincipalTransactionsResponse, GetPrincipalTransactionsQuery>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  getContract(context: DatasourceStacksApiContext, contractId: string) {
    const path = `/extended/v1/contract/${contractId}`;
    return this._request<ContractApiResponse, undefined>(context, {
      path,
      method: "GET",
    });
  },

  getContractLogs(
    context: DatasourceStacksApiContext,
    contractId: string,
    options: GetContractLogsQuery = {},
  ) {
    const { limit = 100, cursor, ...rest } = options;
    const path = `/extended/v2/smart-contracts/${contractId}/logs`;
    return this._request<ContractLogsResponse, GetContractLogsQuery>(context, {
      path,
      method: "GET",
      query: { limit, cursor, ...rest },
    });
  },

  callReadFunction(
    context: DatasourceStacksApiContext,
    contractId: string,
    functionName: string,
    options: { args?: string[]; sender?: string; tip?: number } = {},
  ) {
    const { args = [], sender = "ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM", tip } = options;
    const path = `/v2/contracts/call-read/${contractId}/${functionName}`;
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
};
