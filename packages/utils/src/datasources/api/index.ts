import { Result } from "better-result";
import { request } from "undici";

import {
  StacksApiResponseError,
  StacksApiParseError,
  type StacksApiError,
  StacksApiUnexpectedError,
} from "./errors.ts";

export const datasourceStacksApi = {
  async _request<T>(path: string): Promise<Result<T, StacksApiError>> {
    return Result.tryPromise({
      try: async () => {
        const { statusCode, statusText, body } = await request(`https://api.hiro.so${path}`);

        if (statusCode !== 200) {
          let errorData = await body.json().catch(() => body.text().catch(() => null));
          throw new StacksApiResponseError({ status: statusCode, path, statusText, errorData });
        }

        try {
          const data = await body.json();
          return data as T;
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
          : new StacksApiUnexpectedError({ message: "Unexpected error", cause: error, path }),
    });
  },

  getBlockByHash(hash: string) {
    return this._request<{ hash: string; block_height: number }>(`/extended/v2/blocks/${hash}`);
  },

  getTransaction(txId: string) {
    return this._request<{ tx_id: string }>(`/extended/v1/tx/${txId}`);
  },
};
