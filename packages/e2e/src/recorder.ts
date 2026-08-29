import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

export interface FixtureEntry {
  statusCode: number;
  headers?: Record<string, string>;
  body: unknown;
}

export interface FixtureArchive {
  [requestKey: string]: FixtureEntry;
}

const currentDir = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.resolve(currentDir, "../fixtures");

export function normalizeKey(method: string, rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    url.searchParams.sort();
    return `${method.toUpperCase()} ${decodeURIComponent(url.toString())}`;
  } catch {
    const decodedUrl = decodeURIComponent(rawUrl);
    return `${method.toUpperCase()} ${decodedUrl}`;
  }
}

export function sanitizePayload(rawUrl: string, body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }

  // Contract response: strip huge source_code and abi
  if (rawUrl.includes("/extended/v1/contract/")) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const contract = body as Record<string, unknown>;
    return {
      ...contract,
      source_code: "",
      abi: "{}",
    };
  }

  return body;
}

export interface ScenarioRecorder {
  handleRequest: (
    rawUrl: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<{
    statusCode: number;
    headers?: Record<string, string>;
    body: {
      json: () => Promise<unknown>;
      text: () => Promise<string>;
    };
  }>;
  save: () => Promise<void>;
  isRecording: boolean;
  size: () => number;
}

export function createScenarioRecorder(fixtureFileName: string): ScenarioRecorder {
  const fixturePath = path.isAbsolute(fixtureFileName)
    ? fixtureFileName
    : path.join(FIXTURES_DIR, fixtureFileName);

  const shouldRecord =
    process.env.RECORD === "true" || process.env.RECORD === "1" || !fs.existsSync(fixturePath);

  let archive: FixtureArchive = {};

  if (fs.existsSync(fixturePath)) {
    try {
      const content = fs.readFileSync(fixturePath, "utf8");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const rawArchive = JSON.parse(content) as FixtureArchive;
      archive = {};
      for (const [rawKey, entry] of Object.entries(rawArchive)) {
        const spaceIndex = rawKey.indexOf(" ");
        if (spaceIndex === -1) {
          archive[rawKey] = entry;
        } else {
          const method = rawKey.slice(0, spaceIndex);
          const url = rawKey.slice(spaceIndex + 1);
          archive[normalizeKey(method, url)] = {
            ...entry,
            body: sanitizePayload(url, entry.body),
          };
        }
      }
    } catch {
      archive = {};
    }
  }

  let modified = false;

  return {
    isRecording: shouldRecord,
    size: () => Object.keys(archive).length,

    async handleRequest(rawUrl, init) {
      const method = init?.method ?? "GET";
      const key = normalizeKey(method, rawUrl);

      // Replay mode if fixture key exists and not explicitly forced RECORD=true
      if (!process.env.RECORD && key in archive) {
        const entry = archive[key];
        return {
          statusCode: entry.statusCode,
          headers: entry.headers,
          body: {
            json: () => Promise.resolve(entry.body),
            text: () =>
              Promise.resolve(
                typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body),
              ),
          },
        };
      }

      // Record mode: fetch from live API using native fetch
      const requestHeaders: Record<string, string> = {
        ...(process.env.HIRO_API_KEY ? { "x-api-key": process.env.HIRO_API_KEY } : {}),
        ...init?.headers,
      };

      let liveRes: Response | null = null;
      for (let attempt = 0; attempt < 5; attempt += 1) {
        // oxlint-disable-next-line no-await-in-loop
        liveRes = await globalThis.fetch(rawUrl, {
          method,
          headers: requestHeaders,
          body: init?.body,
        });

        if (liveRes.status === 429) {
          const retryAfterSec = Number(liveRes.headers.get("retry-after") ?? 1);
          const waitMs = Math.max(retryAfterSec * 1000, 1000);
          // oxlint-disable-next-line no-await-in-loop
          await new Promise((resolve) => {
            globalThis.setTimeout(resolve, waitMs);
          });
        } else {
          break;
        }
      }

      if (!liveRes) {
        throw new Error(`Failed to fetch ${rawUrl}`);
      }

      const text = await liveRes.text();
      const bodyData: unknown = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })();

      const entry: FixtureEntry = {
        statusCode: liveRes.status,
        body: sanitizePayload(rawUrl, bodyData),
      };

      archive[key] = entry;
      modified = true;

      return {
        statusCode: entry.statusCode,
        headers: { "content-type": "application/json" },
        body: {
          json: () => Promise.resolve(entry.body),
          text: () =>
            Promise.resolve(
              typeof entry.body === "string" ? entry.body : JSON.stringify(entry.body),
            ),
        },
      };
    },

    save() {
      if (modified || shouldRecord) {
        fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
        const sanitizedArchive: FixtureArchive = {};
        for (const [key, entry] of Object.entries(archive)) {
          const spaceIndex = key.indexOf(" ");
          const url = spaceIndex === -1 ? key : key.slice(spaceIndex + 1);
          sanitizedArchive[key] = {
            ...entry,
            body: sanitizePayload(url, entry.body),
          };
        }
        fs.writeFileSync(fixturePath, JSON.stringify(sanitizedArchive, null, 2), "utf8");
      }
      return Promise.resolve();
    },
  };
}
