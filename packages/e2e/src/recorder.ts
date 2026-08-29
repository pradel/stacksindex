import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

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

function normalizeKey(method: string, rawUrl: string): string {
  const decodedUrl = decodeURIComponent(rawUrl);
  return `${method.toUpperCase()} ${decodedUrl}`;
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
      archive = JSON.parse(content) as FixtureArchive;
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

      const liveRes = await globalThis.fetch(rawUrl, {
        method,
        headers: requestHeaders,
        body: init?.body,
      });

      const text = await liveRes.text();
      const bodyData: unknown = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return text;
        }
      })();

      const headersRecord: Record<string, string> = {};
      liveRes.headers.forEach((value, headerName) => {
        headersRecord[headerName] = value;
      });

      const entry: FixtureEntry = {
        statusCode: liveRes.status,
        headers: headersRecord,
        body: bodyData,
      };

      archive[key] = entry;
      modified = true;

      return {
        statusCode: entry.statusCode,
        headers: entry.headers,
        body: {
          json: () => Promise.resolve(entry.body),
          text: () => Promise.resolve(text),
        },
      };
    },

    save() {
      if (modified || shouldRecord) {
        fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
        fs.writeFileSync(fixturePath, JSON.stringify(archive, null, 2), "utf8");
      }
      return Promise.resolve();
    },
  };
}
