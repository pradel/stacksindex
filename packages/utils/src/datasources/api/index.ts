import { Result } from "better-result";
import { request } from "undici";

import {
  type StacksApiError,
  StacksApiParseError,
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
}

export interface ContractLogsResponse {
  results: ContractLog[];
  limit: number;
  offset: number;
  total: number;
  next_cursor: string | null;
  prev_cursor: string | null;
}

export interface ContractLog {
  tx_id: string;
  event_index: number;
  event_type: string;
  contract_id: string;
  topic: string;
  value: {
    hex: string;
    repr: string;
  };
}

export const datasourceStacksApi = {
  async _request<ResponseT>(path: string): Promise<Result<ResponseT, StacksApiError>> {
    return Result.tryPromise({
      try: async () => {
        const { statusCode, statusText, body } = await request(`https://api.hiro.so${path}`);

        if (statusCode !== 200) {
          const errorData = await body.json().catch(() => body.text().catch(() => null));
          throw new StacksApiResponseError({ status: statusCode, path, statusText, errorData });
        }

        try {
          const data = await body.json();
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
        StacksApiResponseError.is(error) || StacksApiParseError.is(error)
          ? error
          : new StacksApiUnexpectedError({
              message: "Unexpected Stacks API error",
              cause: error,
              path,
            }),
    });
  },

  getBlockByHash(hash: string) {
    return this._request<BlockApiResponse>(`/extended/v2/blocks/${hash}`);
  },

  getTransaction(txId: string) {
    return this._request<TransactionApiResponse>(`/extended/v1/tx/${txId}`);
  },

  getContractLogs(contractId: string, cursor?: string | null) {
    const limit = 50;
    const cursorParam =
      cursor !== null && cursor !== undefined && cursor !== "" ? `&cursor=${cursor}` : "";
    const path = `/extended/v2/smart-contracts/${contractId}/logs?limit=${limit}${cursorParam}`;
    return this._request<ContractLogsResponse>(path);
  },
};
