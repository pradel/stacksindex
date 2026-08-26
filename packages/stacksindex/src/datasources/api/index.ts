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

export interface BlockApiResponse {
  canonical: boolean;
  height: number;
  hash: string;
  block_time: number;
  block_time_iso: string;
  tenure_height: number;
  index_block_hash: string;
  parent_block_hash: string;
  parent_index_block_hash: string;
  burn_block_time: number;
  burn_block_time_iso: string;
  burn_block_hash: string;
  burn_block_height: number;
  miner_txid: string;
  tx_count: number;
  execution_cost_read_count: number;
  execution_cost_read_length: number;
  execution_cost_runtime: number;
  execution_cost_write_count: number;
  execution_cost_write_length: number;
}

export interface TransactionApiResponse {
  tx_id: string;
  type: string;
  status: string;
  fee_rate: string;
  sender: {
    address: string;
    nonce: number;
  };
  sponsor?: {
    address: string;
    nonce: number;
  } | null;
  block: {
    hash: string;
    height: number;
    time: number;
    tx_index: number;
    index_hash?: string;
  };
  bitcoin_block?: {
    height: number;
    time: number;
    hash?: string;
  };
  parent_block?: {
    hash: string;
  };
  execution_cost?: {
    read_count: number;
    read_length: number;
    runtime: number;
    write_count: number;
    write_length: number;
  };
  result?: {
    hex: string;
    repr: string;
  } | null;
  vm_error?: null | string;
  events?: ContractEvent[];
  // oxlint-disable-next-line typescript/no-explicit-any
  post_conditions?: any[];
  [key: string]: unknown;
}

export interface CursorPagination {
  next: string | null;
  previous: string | null;
  current: string;
}

export interface PrincipalTransactionItem {
  transaction: TransactionApiResponse;
  involvement: "sender" | "sponsor" | "affected";
  balance_changes?: {
    stx?: {
      sent: string;
      received: string;
      net: string;
    };
  };
  affected_balances?: {
    stx: boolean;
    ft: boolean;
    nft: boolean;
  };
}

export interface PrincipalTransactionsResponse {
  limit: number;
  total: number;
  cursor: CursorPagination;
  results: PrincipalTransactionItem[];
}

export type AddressTransactionsResponse = PrincipalTransactionsResponse;

export interface ContractLogsResponse {
  limit: number;
  offset: number;
  total: number;
  next_cursor: string | null;
  prev_cursor: string | null;
  results: ContractEvent[];
}

export type BatchTransactionResult =
  | { found: true; result: TransactionApiResponse }
  | { found: false; tx_id: string };

interface AbstractTransactionEvent {
  event_index: number;
}

export interface SmartContractLogEvent extends AbstractTransactionEvent {
  event_type: "smart_contract_log";
  tx_id: string;
  contract_log: {
    contract_id: string;
    topic: string;
    value: {
      hex: string;
      repr: string;
    };
  };
}

export interface StxLockEvent extends AbstractTransactionEvent {
  event_type: "stx_lock";
  tx_id: string;
  stx_lock_event: {
    locked_amount: string;
    unlock_height: number;
    locked_address: string;
  };
}

export interface StxAssetEvent extends AbstractTransactionEvent {
  event_type: "stx_asset";
  tx_id: string;
  asset: {
    asset_event_type: "transfer" | "mint" | "burn";
    sender: string;
    recipient: string;
    amount: string;
    memo?: string;
  };
}

export interface FungibleTokenAssetEvent extends AbstractTransactionEvent {
  event_type: "fungible_token_asset";
  tx_id: string;
  asset: {
    asset_event_type: "transfer" | "mint" | "burn";
    asset_id: string;
    sender: string;
    recipient: string;
    amount: string;
  };
}

export interface NonFungibleTokenAssetEvent extends AbstractTransactionEvent {
  event_type: "non_fungible_token_asset";
  tx_id: string;
  asset: {
    asset_event_type: "transfer" | "mint" | "burn";
    asset_id: string;
    sender: string;
    recipient: string;
    value: {
      hex: string;
      repr: string;
    };
  };
}

export type ContractEvent =
  | SmartContractLogEvent
  | StxLockEvent
  | StxAssetEvent
  | FungibleTokenAssetEvent
  | NonFungibleTokenAssetEvent;

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

  getTransaction(
    context: DatasourceStacksApiContext,
    txId: string,
    options: {
      include?: ("function_args" | "source_code" | "post_conditions" | "result")[];
    } = {},
  ) {
    const { include } = options;
    return this._request<TransactionApiResponse>(context, {
      path: `/extended/v3/transactions/${txId}`,
      method: "GET",
      query: { include: include && include.length > 0 ? include.join(",") : null },
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
      .filter((entry): entry is TransactionApiResponse => entry !== null);

    return Result.ok(results);
  },

  getPrincipalTransactions(
    context: DatasourceStacksApiContext,
    principal: string,
    options: { limit?: number; cursor?: string | null } = {},
  ) {
    const { limit = 50, cursor } = options;
    const path = `/extended/v3/principals/${principal}/transactions`;
    return this._request<PrincipalTransactionsResponse>(context, {
      path,
      method: "GET",
      query: { limit, cursor: cursor ?? null },
    });
  },

  getAddressTransactions(
    context: DatasourceStacksApiContext,
    address: string,
    options: { limit?: number; cursor?: string | null } = {},
  ) {
    return this.getPrincipalTransactions(context, address, options);
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
