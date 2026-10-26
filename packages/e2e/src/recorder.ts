import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  type BenchmarkSummary,
  type BenchmarkTracker,
  createBenchmarkTracker,
} from "./benchmark.ts";

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

interface JsonObject {
  [key: string]: JsonValue;
}

export interface FixtureEntry {
  statusCode: number;
  headers?: Record<string, string>;
  body: JsonValue;
}

export interface FixtureArchive {
  [requestKey: string]: FixtureEntry;
}

export interface RecorderResponse {
  statusCode: number;
  headers?: Record<string, string>;
  body: {
    json: () => Promise<JsonValue>;
    text: () => Promise<string>;
  };
}

const isJsonValue = (value: unknown): value is JsonValue => {
  if (value === null) {
    return true;
  }

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.values(value).every((item) => isJsonValue(item));
  }

  return false;
};

const isJsonObject = (value: JsonValue): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isJsonString = (value: JsonValue): value is string => typeof value === "string";

const isFixtureEntry = (value: JsonValue): value is FixtureEntry & JsonObject =>
  isJsonObject(value) && typeof value.statusCode === "number";

const jsonResponse = (
  statusCode: number,
  body: JsonValue,
  headers?: Record<string, string>,
): RecorderResponse => ({
  statusCode,
  headers,
  body: {
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(isJsonString(body) ? body : JSON.stringify(body)),
  },
});

const isStringUrl = (value: string | URL | Request): value is string => typeof value === "string";

const toRequestUrl = (rawUrl: string | URL | Request): string => {
  if (isStringUrl(rawUrl)) {
    return rawUrl;
  }

  if (rawUrl instanceof globalThis.URL) {
    return rawUrl.href;
  }

  return rawUrl.url;
};

const parseBody = (text: string): JsonValue => {
  try {
    const parsed: unknown = JSON.parse(text);

    return isJsonValue(parsed) ? parsed : text;
  } catch {
    return text;
  }
};

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

const sanitizeContract = (body: JsonObject): JsonValue => {
  const sanitized: JsonObject = {
    contract_id: body.contract_id,
    tx_id: body.tx_id,
    clarity_version: body.clarity_version ?? null,
  };

  const { block } = body;

  if (isJsonObject(block)) {
    sanitized.block = { height: block.height };
  }

  return sanitized;
};

const sanitizePrincipalTransactions = (body: JsonObject): JsonValue => {
  const results = Array.isArray(body.results)
    ? body.results.map((item) => {
        if (!isJsonObject(item)) {
          return item;
        }

        const { transaction: tx } = item;

        if (!isJsonObject(tx)) {
          return item;
        }

        const { block, bitcoin_block: bitcoinBlock } = tx;
        const transaction: JsonObject = { tx_id: tx.tx_id, event_count: tx.event_count };

        if (isJsonObject(block)) {
          transaction.block = {
            height: block.height,
            tx_index: block.tx_index,
          };
        }

        if (isJsonObject(bitcoinBlock)) {
          transaction.bitcoin_block = { height: bitcoinBlock.height };
        }

        return { transaction };
      })
    : body.results;

  return {
    total: body.total,
    limit: body.limit,
    cursor: body.cursor,
    results,
  };
};

const sanitizeTransactionEvents = (body: JsonObject): JsonValue => ({
  total: body.total,
  limit: body.limit,
  cursor: body.cursor,
  results: body.results,
});

const sanitizeContractLogs = (body: JsonObject): JsonValue => {
  // Only `next_cursor` is consumed (forward pagination). The human-readable
  // `repr` is dropped: handlers decode `hex`, and the events table accepts an
  // Empty `value_repr`.
  const results = Array.isArray(body.results)
    ? body.results.map((item) => {
        if (!isJsonObject(item)) {
          return item;
        }

        const { contract_log: contractLog } = item;

        if (!isJsonObject(contractLog)) {
          return item;
        }

        const { value } = contractLog;
        const sanitizedLog: JsonObject = { ...contractLog };

        if (isJsonObject(value)) {
          sanitizedLog.value = { hex: value.hex, repr: "" };
        }

        return { ...item, contract_log: sanitizedLog };
      })
    : body.results;

  return {
    limit: body.limit,
    offset: body.offset,
    total: body.total,
    next_cursor: body.next_cursor ?? null,
    results,
  };
};

const sanitizeTransactionSummary = (tx: JsonObject): JsonValue => {
  // Only the fields consumed by encodeTransaction and encodeBlock are kept.
  const sanitized: JsonObject = {
    tx_id: tx.tx_id,
    type: tx.type,
    status: tx.status,
    fee_rate: tx.fee_rate,
  };

  const { sender, block, bitcoin_block: bitcoinBlock } = tx;

  if (isJsonObject(sender)) {
    sanitized.sender = {
      address: sender.address,
      nonce: sender.nonce,
    };
  }

  if (isJsonObject(block)) {
    sanitized.block = {
      hash: block.hash,
      index_hash: block.index_hash,
      height: block.height,
      tx_index: block.tx_index,
    };
  }

  if (isJsonObject(bitcoinBlock)) {
    sanitized.bitcoin_block = {
      height: bitcoinBlock.height,
      time: bitcoinBlock.time,
    };
  }

  return sanitized;
};

const sanitizeTransactionsBatch = (body: JsonObject): JsonValue => {
  const results = Array.isArray(body.results)
    ? body.results.map((item) => (isJsonObject(item) ? sanitizeTransactionSummary(item) : item))
    : body.results;

  return { results };
};

/** Copies `fields` of `body`; fields a fixture lacks stay absent. */
const pickFields = (body: JsonObject, fields: readonly string[]): JsonObject => {
  const picked: JsonObject = {};

  for (const field of fields) {
    if (field in body) {
      picked[field] = body[field];
    }
  }

  return picked;
};

const mapResults = (
  body: JsonObject,
  sanitizeRow: (row: JsonObject) => JsonValue,
): JsonValue | undefined =>
  Array.isArray(body.results)
    ? body.results.map((item) => (isJsonObject(item) ? sanitizeRow(item) : item))
    : body.results;

// Only the fields consumed by encodeBlock (and the reorg check's `hash`) are
// Kept; blockTime and TenureHeight are derived from the burn block.
const sanitizeBlock = (body: JsonObject): JsonValue =>
  pickFields(body, ["height", "hash", "index_block_hash", "burn_block_time", "burn_block_height"]);

// `GET /extended/v2/blocks` pages: rows feed live heads and the blocks linking
// A head to the anchor (`toLightBlock`), which also read the parent hash, the
// Stacks block time, the tenure height and the transaction count.
const sanitizeBlocksPageRow = (row: JsonObject): JsonValue =>
  pickFields(row, [
    "height",
    "hash",
    "index_block_hash",
    "burn_block_time",
    "burn_block_height",
    "parent_block_hash",
    "block_time",
    "tenure_height",
    "tx_count",
  ]);

const sanitizeBlocksPage = (body: JsonObject): JsonValue => ({
  ...pickFields(body, ["limit", "offset", "total"]),
  results: mapResults(body, sanitizeBlocksPageRow) ?? null,
});

// `GET /extended/v3/blocks` pages: block sources read these rows' Stacks
// Fields and their burn block height.
const sanitizeV3BlockRow = (row: JsonObject): JsonValue => {
  const sanitized = pickFields(row, ["height", "hash", "index_hash", "tenure_height"]);
  const { bitcoin_block: bitcoinBlock } = row;

  if (isJsonObject(bitcoinBlock)) {
    sanitized.bitcoin_block = pickFields(bitcoinBlock, ["height"]);
  }

  return sanitized;
};

const sanitizeV3BlocksPage = (body: JsonObject): JsonValue => ({
  ...pickFields(body, ["cursor", "limit", "total"]),
  results: mapResults(body, sanitizeV3BlockRow) ?? null,
});

// `GET /extended/v3/bitcoin-blocks` pages: burn block times of block sources.
const sanitizeBitcoinBlocksPage = (body: JsonObject): JsonValue => ({
  ...pickFields(body, ["cursor", "limit", "total"]),
  results: mapResults(body, (row) => pickFields(row, ["height", "time"])) ?? null,
});

const urlPathname = (rawUrl: string): string => {
  try {
    return new URL(rawUrl).pathname;
  } catch {
    return rawUrl.split("?")[0];
  }
};

const sanitizeStatus = (body: JsonObject): JsonValue => {
  const sanitized: JsonObject = {
    server_version: body.server_version,
    status: body.status,
  };

  const chainTip = body.chain_tip;

  if (isJsonObject(chainTip)) {
    // The hash anchors the next run's reorg check.
    sanitized.chain_tip = { block_height: chainTip.block_height, block_hash: chainTip.block_hash };
  }

  return sanitized;
};

// Only the fields consumed by checkTransactionForMatchingEvent to construct
// The first log cursor are kept (microblock_sequence, block_height, tx_index).
const sanitizeV1Transaction = (body: JsonObject): JsonValue => ({
  tx_id: body.tx_id,
  block_height: body.block_height,
  tx_index: body.tx_index,
  microblock_sequence: body.microblock_sequence,
});

export function sanitizePayload(rawUrl: string, body: JsonValue): JsonValue {
  if (!isJsonObject(body)) {
    return body;
  }

  if (rawUrl.includes("/extended/v3/smart-contracts/")) {
    return sanitizeContract(body);
  }

  if (rawUrl.includes("/extended/v1/tx/")) {
    return sanitizeV1Transaction(body);
  }

  if (rawUrl.includes("/extended/v3/principals/") && rawUrl.includes("/transactions")) {
    return sanitizePrincipalTransactions(body);
  }

  if (rawUrl.includes("/extended/v3/transactions/batch")) {
    return sanitizeTransactionsBatch(body);
  }

  if (rawUrl.includes("/extended/v3/transactions/") && rawUrl.includes("/events")) {
    return sanitizeTransactionEvents(body);
  }

  if (rawUrl.includes("/extended/v2/smart-contracts/") && rawUrl.includes("/logs")) {
    return sanitizeContractLogs(body);
  }

  if (rawUrl.includes("/extended/v2/blocks/")) {
    return sanitizeBlock(body);
  }

  const pathname = urlPathname(rawUrl);

  if (pathname.endsWith("/extended/v2/blocks")) {
    return sanitizeBlocksPage(body);
  }

  if (pathname.endsWith("/extended/v3/blocks")) {
    return sanitizeV3BlocksPage(body);
  }

  if (pathname.endsWith("/extended/v3/bitcoin-blocks")) {
    return sanitizeBitcoinBlocksPage(body);
  }

  if (rawUrl.endsWith("/extended")) {
    return sanitizeStatus(body);
  }

  return body;
}

const loadArchive = (fixturePath: string): FixtureArchive => {
  if (!fs.existsSync(fixturePath)) {
    return {};
  }

  try {
    const content = fs.readFileSync(fixturePath, "utf8");
    const parsed: unknown = JSON.parse(content);

    if (!isJsonValue(parsed) || !isJsonObject(parsed)) {
      return {};
    }

    const archive: FixtureArchive = {};

    for (const [rawKey, entry] of Object.entries(parsed)) {
      if (isFixtureEntry(entry)) {
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
    }

    return archive;
  } catch {
    return {};
  }
};

const recordLiveResponse = async (
  liveFetch: typeof globalThis.fetch,
  rawUrl: string,
  method: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<FixtureEntry> => {
  const requestHeaders: Record<string, string> = {};

  if (process.env.HIRO_API_KEY) {
    requestHeaders["x-api-key"] = process.env.HIRO_API_KEY;
  }

  for (const [header, headerValue] of Object.entries(init?.headers ?? {})) {
    requestHeaders[header] = headerValue;
  }

  let liveRes: Response | null = null;

  for (let attempt = 0; attempt < 5; attempt += 1) {
    liveRes = await liveFetch(rawUrl, {
      method,
      headers: requestHeaders,
      body: init?.body,
    });

    if (liveRes.status !== 429) {
      break;
    }

    if (attempt === 4) {
      throw new Error(`Rate limited after 5 attempts: ${rawUrl}`);
    }

    const retryAfterSec = Number(liveRes.headers.get("retry-after") ?? 1);
    const waitMs = Math.max(retryAfterSec * 1000, 1000);
    await new Promise((resolve) => {
      globalThis.setTimeout(resolve, waitMs);
    });
  }

  if (!liveRes) {
    throw new Error(`Failed to fetch ${rawUrl}`);
  }

  const text = await liveRes.text();

  return {
    statusCode: liveRes.status,
    body: sanitizePayload(rawUrl, parseBody(text)),
  };
};

export interface ScenarioRecorder {
  handleRequest: (
    rawUrl: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<RecorderResponse>;
  handleFetch: (
    rawUrl: string | URL | Request,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ) => Promise<Response>;
  save: () => Promise<void>;
  isRecording: boolean;
  size: () => number;
  tracker: BenchmarkTracker;
  getBenchmarkSummary: () => BenchmarkSummary;
}

export function createScenarioRecorder(
  fixtureFileName: string,
  options?: { tracker?: BenchmarkTracker },
): ScenarioRecorder {
  const tracker = options?.tracker ?? createBenchmarkTracker();

  const fixturePath = path.isAbsolute(fixtureFileName)
    ? fixtureFileName
    : path.join(FIXTURES_DIR, fixtureFileName);

  const shouldRecord =
    process.env.RECORD === "true" || process.env.RECORD === "1" || !fs.existsSync(fixturePath);

  const archive: FixtureArchive = loadArchive(fixturePath);
  let modified = false;
  // Capture the real fetch at creation time so that stubbing `globalThis.fetch`
  // With `handleFetch` does not recurse when recording against the live API.
  const liveFetch = globalThis.fetch.bind(globalThis);

  return {
    isRecording: shouldRecord,
    size: () => Object.keys(archive).length,
    tracker,
    getBenchmarkSummary: () => tracker.getSummary(),

    async handleRequest(rawUrl, init) {
      const method = init?.method ?? "GET";
      tracker.recordCall(method, rawUrl);
      const key = normalizeKey(method, rawUrl);

      // Replay mode when recording is not required and the fixture key exists.
      if (!shouldRecord && key in archive) {
        const entry = archive[key];

        return jsonResponse(entry.statusCode, entry.body, entry.headers);
      }

      // Record mode: fetch from live API using native fetch
      const entry = await recordLiveResponse(liveFetch, rawUrl, method, init);
      archive[key] = entry;
      modified = true;

      return jsonResponse(entry.statusCode, entry.body, {
        "content-type": "application/json",
      });
    },

    async handleFetch(
      rawUrl: string | URL | Request,
      init?: { method?: string; headers?: Record<string, string>; body?: string },
    ): Promise<Response> {
      const url = toRequestUrl(rawUrl);

      const res = await this.handleRequest(url, {
        method: init?.method,
        headers: { ...init?.headers },
        body: init?.body,
      });

      let statusText = String(res.statusCode);

      if (res.statusCode === 200) {
        statusText = "OK";
      } else if (res.statusCode === 404) {
        statusText = "Not Found";
      }

      const data = await res.body.json();

      return new globalThis.Response(isJsonString(data) ? data : JSON.stringify(data), {
        status: res.statusCode,
        statusText,
        headers: { "content-type": "application/json", ...res.headers },
      });
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
