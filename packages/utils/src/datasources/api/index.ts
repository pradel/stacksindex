import { Result, UnhandledException } from "better-result";
import { request } from "undici";

import { StacksApiResponseError, StacksApiParseError, type StacksApiError } from "./errors.ts";

export const datasourceStacksApi = {
  async _request(path: string): Promise<Result<unknown, StacksApiError | UnhandledException>> {
    return Result.tryPromise(async () => {
      const { statusCode, statusText, body } = await request(`https://api.hiro.so${path}`);

      if (statusCode !== 200) {
        let errorData = await body.json().catch(() => body.text().catch(() => null));
        return new StacksApiResponseError({ status: statusCode, path, statusText, errorData });
      }

      try {
        const data = await body.json();
        return data;
      } catch (error) {
        return new StacksApiParseError({
          message: error instanceof Error ? error.message : String(error),
          cause: error,
        });
      }
    });
  },

  getBlockByHash(hash: string) {
    return this._request(`/extended/v2/blocks/${hash}`) as Promise<
      Result<
        {
          hash: string;
          block_height: number;
        },
        StacksApiError
      >
    >;
  },

  getTransaction(txId: string) {
    return this._request(`/extended/v1/tx/${txId}`) as Promise<
      Result<
        {
          tx_id: string;
        },
        StacksApiError
      >
    >;
  },
};
