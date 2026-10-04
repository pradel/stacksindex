import { vi } from "vite-plus/test";

export interface MockHttpResponseBody {
  json?: () => unknown;
  text?: () => Promise<string> | string;
}

export interface MockHttpResponse {
  statusCode?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: MockHttpResponseBody;
}

export type MockRequestHandler = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => MockHttpResponse | Promise<MockHttpResponse>;

function toUrlString(rawUrl: unknown): string {
  if (typeof rawUrl === "string") {
    return rawUrl;
  }
  if (rawUrl !== null && typeof rawUrl === "object" && "href" in rawUrl) {
    return String(rawUrl.href);
  }
  return String(rawUrl);
}

function defaultStatusText(status: number): string {
  if (status === 200) {
    return "OK";
  }
  if (status === 400) {
    return "Bad Request";
  }
  if (status === 404) {
    return "Not Found";
  }
  if (status === 429) {
    return "Too Many Requests";
  }
  if (status === 500) {
    return "Internal Server Error";
  }
  return String(status);
}

function toResponse(response: MockHttpResponse): Response {
  const status = response.statusCode ?? 200;
  const headers: Record<string, string | undefined> = response.headers ?? {};
  const body = response.body ?? {};

  return {
    status,
    statusText: response.statusText ?? defaultStatusText(status),
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? headers[name] ?? null,
    },
    json: () =>
      Promise.resolve().then(() => (typeof body.json === "function" ? body.json() : null)),
    text: async () => {
      if (typeof body.text === "function") {
        return body.text();
      }
      if (typeof body.json === "function") {
        return JSON.stringify(await body.json());
      }
      return "";
    },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  } as unknown as Response;
}

/**
 * Adapts a recorder-style request mock into a `fetch` mock that resolves to a
 * `Response`-like object. Lets tests stub `globalThis.fetch` while keeping the
 * `{ statusCode, statusText, headers, body }` fixtures used across the suite.
 */
export function createFetchMock(
  request: MockRequestHandler,
  options?: { fallback?: (url: string, error: unknown) => Response | undefined },
) {
  return vi.fn(
    async (
      rawUrl: unknown,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<Response> => {
      const url = toUrlString(rawUrl);
      // oxlint-disable-next-line init-declarations
      let response: MockHttpResponse;
      try {
        response = await request(url, init);
      } catch (error) {
        const fallbackResponse = options?.fallback?.(url, error);
        if (fallbackResponse !== undefined) {
          return fallbackResponse;
        }
        throw error;
      }
      return toResponse(response);
    },
  );
}
