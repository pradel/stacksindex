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

export type TransactionApiResponse =
  paths["/extended/v1/tx/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type BatchTransactionsApiResponse =
  paths["/extended/v1/tx/multiple"]["get"]["responses"]["200"]["content"]["application/json"];

export type BatchTransactionResult = BatchTransactionsApiResponse[string];

export type AddressTransactionsResponse =
  paths["/extended/v1/address/{principal}/transactions"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractLogsResponse =
  paths["/extended/v2/smart-contracts/{contract_id}/logs"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractEvent = Extract<
  TransactionApiResponse,
  { events: unknown[] }
>["events"][number];

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

interface RequestOptions {
  path: string;
  method: "GET" | "POST";
  query?: Record<string, string | string[] | number | number[] | bigint | bigint[] | null>;
  body?: unknown;
}

export const datasourceStacksApi = {
  async _request<ResponseT>(
    context: DatasourceStacksApiContext,
    options: RequestOptions,
  ): Promise<Result<ResponseT, StacksApiError>> {
    return this._requestWithRetry(context, options, 0);
  },

  async _requestWithRetry<ResponseT>(
    context: DatasourceStacksApiContext,
    options: RequestOptions,
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
          if (entry !== null) {
            const str = typeof entry === "string" ? entry : entry.toString();
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

  getBlockByHash(context: DatasourceStacksApiContext, hash: string) {
    return this._request<BlockApiResponse>(context, {
      path: `/extended/v2/blocks/${hash}`,
      method: "GET",
    });
  },

  getTransaction(context: DatasourceStacksApiContext, txId: string) {
    return this._request<TransactionApiResponse>(context, {
      path: `/extended/v1/tx/${txId}`,
      method: "GET",
    });
  },

  async getTransactions(
    context: DatasourceStacksApiContext,
    txIds: string[],
  ): Promise<Result<TransactionApiResponse[], StacksApiError>> {
    if (txIds.length === 0) {
      return Result.ok([]);
    }

    const mapResult = await this._request<Record<string, BatchTransactionResult>>(context, {
      path: "/extended/v1/tx/multiple",
      method: "GET",
      query: { tx_id: txIds },
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
      .filter((entry) => entry !== null);

    return Result.ok(results);
  },

  getAddressTransactions(
    context: DatasourceStacksApiContext,
    address: string,
    options: { limit?: number; offset?: number; exclude_function_args?: boolean } = {},
  ) {
    const { limit = 50, offset = 0, exclude_function_args = true } = options;
    const path = `/extended/v1/address/${address}/transactions`;
    return this._request<AddressTransactionsResponse>(context, {
      path,
      method: "GET",
      query: { limit, offset, exclude_function_args: String(exclude_function_args) },
    });
  },

  getContractLogs(
    context: DatasourceStacksApiContext,
    contractId: string,
    options: { limit?: number; cursor?: string | null } = {},
  ) {
    const { limit = 100, cursor } = options;
    const path = `/extended/v2/smart-contracts/${contractId}/logs`;
    return this._request<ContractLogsResponse>(context, {
      path,
      method: "GET",
      query: { limit, cursor: cursor ?? null },
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
    return this._request<CallReadResponse>(context, {
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
