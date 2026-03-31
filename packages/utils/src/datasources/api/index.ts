import { Result, UnhandledException } from "better-result";
import { request } from "undici";

import { StacksApiResponseError, StacksApiParseError, type StacksApiError } from "./errors.ts";

export const datasourceStacksApi = {
  async _request(path: string): Promise<Result<unknown, StacksApiError | UnhandledException>> {
    return Result.tryPromise(async () => {
      const { statusCode, statusText, body } = await request(`https://api.hiro.so${path}`);

      if (statusCode !== 200) {
        return new StacksApiResponseError({ status: statusCode, path, statusText });
      }

      try {
        const data = await body.json();
        return data;
      } catch (error) {
        return new StacksApiParseError({
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
  },

  getBlockByHash(hash: string) {
    return this._request(`/extended/v2/blocks/${hash}`);
  },

  getTransaction(txId: string) {
    return this._request(`/extended/v1/tx/${txId}`);
  },
};
