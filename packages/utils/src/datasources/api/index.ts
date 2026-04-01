import { Result } from "better-result";
import { request } from "undici";

import {
  type StacksApiError,
  StacksApiParseError,
  StacksApiResponseError,
  StacksApiUnexpectedError,
} from "./errors.ts";

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
    return this._request<{ hash: string; block_height: number }>(`/extended/v2/blocks/${hash}`);
  },

  getTransaction(txId: string) {
    return this._request<{ tx_id: string }>(`/extended/v1/tx/${txId}`);
  },
};
