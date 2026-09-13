import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, URL } from "node:url";

import {
  type BenchmarkSummary,
  type BenchmarkTracker,
  createBenchmarkTracker,
} from "./benchmark.ts";

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

function sanitizeContract(body: Record<string, unknown>): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const block = body.block as Record<string, unknown> | undefined;
  return {
    contract_id: body.contract_id,
    tx_id: body.tx_id,
    clarity_version: body.clarity_version ?? null,
    block: block
      ? {
          height: block.height,
        }
      : undefined,
  };
}

function sanitizePrincipalTransactions(body: Record<string, unknown>): Record<string, unknown> {
  const results = Array.isArray(body.results)
    ? body.results.map((item: unknown) => {
        if (!item || typeof item !== "object") {
          return item;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const itemObj = item as Record<string, unknown>;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const tx = itemObj.transaction as Record<string, unknown> | undefined;
        if (!tx) {
          return itemObj;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const block = tx.block as Record<string, unknown> | undefined;
        return {
          transaction: {
            tx_id: tx.tx_id,
            block: block
              ? {
                  height: block.height,
                  tx_index: block.tx_index,
                }
              : undefined,
          },
        };
      })
    : body.results;

  return {
    total: body.total,
    limit: body.limit,
    cursor: body.cursor,
    results,
  };
}

function sanitizeTransactionEvents(body: Record<string, unknown>): Record<string, unknown> {
  return {
    total: body.total,
    limit: body.limit,
    cursor: body.cursor,
    results: body.results,
  };
}

function sanitizeContractLogs(body: Record<string, unknown>): Record<string, unknown> {
  // Only `next_cursor` is consumed (forward pagination). The human-readable
  // `repr` is dropped: handlers decode `hex`, and the events table accepts an
  // Empty `value_repr`.
  const results = Array.isArray(body.results)
    ? body.results.map((item: unknown) => {
        if (!item || typeof item !== "object") {
          return item;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const itemObj = item as Record<string, unknown>;
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const contractLog = itemObj.contract_log as Record<string, unknown> | undefined;
        if (!contractLog || typeof contractLog !== "object") {
          return itemObj;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const value = contractLog.value as Record<string, unknown> | undefined;
        return {
          ...itemObj,
          contract_log: {
            ...contractLog,
            value: value ? { hex: value.hex, repr: "" } : value,
          },
        };
      })
    : body.results;

  return {
    limit: body.limit,
    offset: body.offset,
    total: body.total,
    next_cursor: body.next_cursor ?? null,
    results,
  };
}

function sanitizeTransactionSummary(tx: Record<string, unknown>): Record<string, unknown> {
  // Only the fields consumed by encodeTransaction and encodeBlock are kept. The batch
  // Endpoint returns summaries without event_count or events.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const block = tx.block as Record<string, unknown> | undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const sender = tx.sender as Record<string, unknown> | undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const bitcoinBlock = tx.bitcoin_block as Record<string, unknown> | undefined;

  return {
    tx_id: tx.tx_id,
    type: tx.type,
    status: tx.status,
    fee_rate: tx.fee_rate,
    sender: sender
      ? {
          address: sender.address,
          nonce: sender.nonce,
        }
      : undefined,
    block: block
      ? {
          hash: block.hash,
          height: block.height,
          tx_index: block.tx_index,
        }
      : undefined,
    ...(bitcoinBlock
      ? {
          bitcoin_block: {
            height: bitcoinBlock.height,
            time: bitcoinBlock.time,
          },
        }
      : {}),
  };
}

function sanitizeTransactionsBatch(body: Record<string, unknown>): Record<string, unknown> {
  const results = Array.isArray(body.results)
    ? body.results.map((item: unknown) => {
        if (!item || typeof item !== "object") {
          return item;
        }
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return sanitizeTransactionSummary(item as Record<string, unknown>);
      })
    : body.results;

  return { results };
}

function sanitizeTransaction(body: Record<string, unknown>): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const block = body.block as Record<string, unknown> | undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const sender = body.sender as Record<string, unknown> | undefined;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const bitcoinBlock = body.bitcoin_block as Record<string, unknown> | undefined;

  return {
    tx_id: body.tx_id,
    event_count: body.event_count,
    type: body.type,
    status: body.status,
    fee_rate: body.fee_rate,
    sender: sender
      ? {
          address: sender.address,
          nonce: sender.nonce,
        }
      : undefined,
    block: block
      ? {
          hash: block.hash,
          height: block.height,
          tx_index: block.tx_index,
        }
      : undefined,
    ...(bitcoinBlock
      ? {
          bitcoin_block: {
            height: bitcoinBlock.height,
            time: bitcoinBlock.time,
          },
        }
      : {}),
    events: body.events,
  };
}

function sanitizeBlock(body: Record<string, unknown>): Record<string, unknown> {
  // Only the fields consumed by encodeBlock are kept (blockTime and
  // TenureHeight are derived from the burn block, not the Stacks block).
  return {
    height: body.height,
    hash: body.hash,
    burn_block_time: body.burn_block_time,
    burn_block_height: body.burn_block_height,
  };
}

function sanitizeStatus(body: Record<string, unknown>): Record<string, unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const chainTip = body.chain_tip as Record<string, unknown> | undefined;
  return {
    server_version: body.server_version,
    status: body.status,
    chain_tip: chainTip ? { block_height: chainTip.block_height } : undefined,
  };
}

function sanitizeV1Transaction(body: Record<string, unknown>): Record<string, unknown> {
  // Only the fields consumed by checkTransactionForMatchingEvent to construct
  // The first log cursor are kept (microblock_sequence, block_height, tx_index).
  return {
    tx_id: body.tx_id,
    block_height: body.block_height,
    tx_index: body.tx_index,
    microblock_sequence: body.microblock_sequence,
  };
}

export function sanitizePayload(rawUrl: string, body: unknown): unknown {
  if (!body || typeof body !== "object") {
    return body;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const obj = body as Record<string, unknown>;

  if (rawUrl.includes("/extended/v3/smart-contracts/")) {
    return sanitizeContract(obj);
  }
  if (rawUrl.includes("/extended/v1/tx/")) {
    return sanitizeV1Transaction(obj);
  }
  if (rawUrl.includes("/extended/v3/principals/") && rawUrl.includes("/transactions")) {
    return sanitizePrincipalTransactions(obj);
  }
  if (rawUrl.includes("/extended/v3/transactions/batch")) {
    return sanitizeTransactionsBatch(obj);
  }
  if (rawUrl.includes("/extended/v3/transactions/") && rawUrl.includes("/events")) {
    return sanitizeTransactionEvents(obj);
  }
  if (rawUrl.includes("/extended/v2/smart-contracts/") && rawUrl.includes("/logs")) {
    return sanitizeContractLogs(obj);
  }
  if (rawUrl.includes("/extended/v3/transactions/")) {
    return sanitizeTransaction(obj);
  }
  if (rawUrl.includes("/extended/v2/blocks/")) {
    return sanitizeBlock(obj);
  }
  if (rawUrl.endsWith("/extended")) {
    return sanitizeStatus(obj);
  }

  return body;
}

/**
 * Parses transaction ids from a batch lookup URL. Supports both repeated
 * (`?tx_id=A&tx_id=B`) and comma-separated (`?tx_id=A,B`) forms. Returns
 * Null when the URL is not a batch lookup.
 */
function tryParseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function parseBatchTxIds(rawUrl: string): string[] | null {
  const url = tryParseUrl(rawUrl);
  if (url?.pathname !== "/extended/v3/transactions/batch") {
    return null;
  }
  const ids: string[] = [];
  for (const value of url.searchParams.getAll("tx_id")) {
    for (const id of value.split(",")) {
      if (id !== "") {
        ids.push(id);
      }
    }
  }
  return ids;
}

function findArchivedTransaction(
  archive: FixtureArchive,
  txId: string,
): Record<string, unknown> | null {
  for (const [rawKey, entry] of Object.entries(archive)) {
    const spaceIndex = rawKey.indexOf(" ");
    const method = spaceIndex === -1 ? "" : rawKey.slice(0, spaceIndex);
    const url = spaceIndex === -1 ? null : tryParseUrl(rawKey.slice(spaceIndex + 1));
    const isArchivedSingle =
      entry.statusCode === 200 &&
      method === "GET" &&
      url?.pathname === `/extended/v3/transactions/${txId}` &&
      url.search === "";
    if (isArchivedSingle) {
      const { body } = entry;
      if (body && typeof body === "object") {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return body as Record<string, unknown>;
      }
    }
  }
  return null;
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
  // oxlint-disable-next-line typescript/no-explicit-any
  handleFetch: (rawUrl: unknown, init?: any) => Promise<Response>;
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
    tracker,
    getBenchmarkSummary: () => tracker.getSummary(),

    async handleRequest(rawUrl, init) {
      const method = init?.method ?? "GET";
      tracker.recordCall(method, rawUrl);
      const key = normalizeKey(method, rawUrl);

      // Replay mode: synthesize batch lookups from archived single-transaction
      // Entries. Fixtures recorded before the batch endpoint existed only
      // Contain individual transaction responses.
      if (!shouldRecord && !(key in archive) && method === "GET") {
        const batchIds = parseBatchTxIds(rawUrl);
        if (batchIds) {
          const results: Record<string, unknown>[] = [];
          let complete = true;
          for (const txId of batchIds) {
            const txBody = findArchivedTransaction(archive, txId);
            if (!txBody) {
              complete = false;
              break;
            }
            results.push(sanitizeTransactionSummary(txBody));
          }
          if (complete) {
            const body = { results };
            return {
              statusCode: 200,
              headers: { "content-type": "application/json" },
              body: {
                json: () => Promise.resolve(body),
                text: () => Promise.resolve(JSON.stringify(body)),
              },
            };
          }
        }
      }

      // Replay mode when recording is not required and the fixture key exists.
      if (!shouldRecord && key in archive) {
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
          if (attempt === 4) {
            throw new Error(`Rate limited after 5 attempts: ${rawUrl}`);
          }
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

    // oxlint-disable-next-line typescript/no-explicit-any
    async handleFetch(rawUrl: unknown, init?: any): Promise<Response> {
      // oxlint-disable-next-line typescript/no-unsafe-member-access
      const url = typeof rawUrl === "string" ? rawUrl : String((rawUrl as any)?.href ?? rawUrl);
      let headersObj: Record<string, string> = {};
      if (init?.headers) {
        // oxlint-disable-next-line typescript/no-unsafe-member-access
        if (typeof init.headers.entries === "function") {
          // oxlint-disable-next-line typescript/no-unsafe-argument, typescript/no-unsafe-call, typescript/no-unsafe-member-access
          headersObj = Object.fromEntries(init.headers.entries());
          // oxlint-disable-next-line typescript/no-unsafe-member-access
        } else if (typeof init.headers === "object") {
          // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-member-access
          headersObj = { ...init.headers };
        }
      }
      // oxlint-disable-next-line typescript/no-unsafe-member-access
      const res = await this.handleRequest(url, {
        method: init?.method,
        headers: headersObj,
        body: init?.body,
      });
      const status = res.statusCode;
      const statusText = status === 200 ? "OK" : status === 404 ? "Not Found" : String(status);
      const data = await res.body.json();
      return new Response(typeof data === "string" ? data : JSON.stringify(data), {
        status,
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
