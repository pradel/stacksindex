import { Result } from "better-result";
import { request } from "undici";

import { StacksApiResponseError, StacksApiParseError } from "./errors.ts";

export const datasourceStacksApi = {
  async getBlockByHash(hash: string) {
    return Result.tryPromise(async () => {
      const { statusCode, body } = await request(`https://api.hiro.so/extended/v2/blocks/${hash}`);

      if (statusCode !== 200) {
        // TODO add more info to the error to help debugging
        return new StacksApiResponseError({ status: statusCode });
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
};
