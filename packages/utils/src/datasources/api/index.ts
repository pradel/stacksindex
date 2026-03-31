import { Result } from "better-result";
import { request } from "undici";

import { StacksApiResponseError, StacksApiParseError } from "./errors.ts";

export const datasourceStacksApi = {
  async getStacks() {
    return Result.tryPromise(async () => {
      const { statusCode, body } = await request("https://stacksindex.com/api/v1/stacks");

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
