/**
 * In-memory Stacks chain served through a `fetch` stub, for tests that follow
 * the chain over several requests (live indexing, per-block fetching).
 *
 * Implements the subset of the Hiro API the indexer uses, with the paging
 * semantics observed on mainnet: contract logs are newest first with
 * `cursor` / `next_cursor` / `prev_cursor`, block transactions and
 * transaction events page through `cursor.next`.
 */
import type { Schema } from "effect";

export interface FakeEvent {
  readonly contractId: string;
  readonly eventIndex: number;
  readonly repr?: string;
}

export interface FakeTransaction {
  readonly txId: string;
  /** Defaults to `"success"`; other statuses keep no events, as on mainnet. */
  readonly status?: string;
  readonly events: readonly FakeEvent[];
  /**
   * Asset events (not contract logs) emitted first, at event indexes
   * `0..assetEvents - 1`; contract logs must use higher indexes.
   */
  readonly assetEvents?: number;
}

export interface FakeBlock {
  readonly height: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly blockTime: number;
  readonly transactions: readonly FakeTransaction[];
}

export interface FakeChain {
  /** Canonical chain, ascending. */
  readonly blocks: FakeBlock[];
  /** Every request as a decoded `pathname?search`, in order. */
  readonly requests: string[];
  /** Requests whose path starts with a key fail with 404 that many times. */
  readonly failures: Map<string, number>;
  /** Heights served instead of the tip by the next head polls (a lagging replica). */
  readonly staleHeads: number[];
  /** Called before each head poll (`GET /extended/v2/blocks?limit=1`) is answered. */
  onHeadPoll: (() => void) | undefined;
  /** Appends a block on top of the tip. */
  readonly mine: (transactions?: readonly FakeTransaction[]) => void;
  /** Drops every block at or above `height`; the next `mine` builds a fork from there. */
  readonly orphanFrom: (height: number) => void;
  readonly fetch: (input: string | URL | Request) => Promise<Response>;
}

const ANCHOR_MICROBLOCK_SEQUENCE = 2_147_483_647;

const isSuccess = (transaction: FakeTransaction) => (transaction.status ?? "success") === "success";

const json = (body: Schema.Json, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    statusText: status === 200 ? "OK" : "Not Found",
    headers: { "content-type": "application/json" },
  });

const notFound = () => json({ error: "not found" }, 404);

interface LogEntry {
  readonly block: FakeBlock;
  readonly txIndex: number;
  readonly transaction: FakeTransaction;
  readonly event: FakeEvent;
}

const logCursor = (entry: LogEntry) =>
  `${entry.block.height}:${ANCHOR_MICROBLOCK_SEQUENCE}:${entry.txIndex}:${entry.event.eventIndex}`;

/** Whether `entry` is at or below the `height:sequence:txIndex:eventIndex` cursor. */
const isAtOrBelowCursor = (entry: LogEntry, cursor: string) => {
  const [height, , txIndex, eventIndex] = cursor.split(":").map(Number);
  const position = [entry.block.height, entry.txIndex, entry.event.eventIndex];
  const bound = [height, txIndex, eventIndex];

  for (let index = 0; index < position.length; index += 1) {
    if (position[index] !== bound[index]) {
      return position[index] < bound[index];
    }
  }

  return true;
};

const blockRow = (block: FakeBlock) => ({
  canonical: true,
  height: block.height,
  hash: block.hash,
  parent_block_hash: block.parentHash,
  block_time: block.blockTime,
  tenure_height: block.height,
  tx_count: block.transactions.length,
  burn_block_time: block.blockTime,
  burn_block_height: block.height,
});

const transactionSummary = (block: FakeBlock, txIndex: number) => ({
  tx_id: block.transactions[txIndex].txId,
  sender: { address: "SP sender", nonce: txIndex },
  sponsor: null,
  fee_rate: "1000",
  block: { height: block.height, hash: block.hash, time: block.blockTime, tx_index: txIndex },
  bitcoin_block: { height: block.height, time: block.blockTime },
  status: block.transactions[txIndex].status ?? "success",
  type: "contract_call",
});

const contractLogValue = (event: FakeEvent) => ({
  contract_id: event.contractId,
  topic: "print",
  value: { hex: "0x01", repr: event.repr ?? "(ok true)" },
});

/** Pages `items` through an offset `cursor`, answering with `cursor.next`. */
const offsetPage = (items: readonly Schema.Json[], params: URLSearchParams) => {
  const limit = Number(params.get("limit") ?? 20);
  const offset = Number(params.get("cursor") ?? 0);
  const next = offset + limit < items.length ? String(offset + limit) : null;

  return json({
    total: items.length,
    limit,
    cursor: { next, previous: null, current: String(offset) },
    results: items.slice(offset, offset + limit),
  });
};

const transactionEvents = (transaction: FakeTransaction) =>
  isSuccess(transaction)
    ? [
        ...Array.from({ length: transaction.assetEvents ?? 0 }, (_, index) => ({
          event_index: index,
          type: "stx_asset",
          stx_asset: { type: "transfer", amount: "1" },
        })),
        ...transaction.events.map((event) => ({
          event_index: event.eventIndex,
          type: "contract_log",
          contract_log: contractLogValue(event),
        })),
      ]
    : [];

export function createFakeChain(options: {
  readonly baseHeight: number;
  /**
   * Rejects logs cursors that do not match an existing event, like older
   * stacks-blockchain-api versions.
   */
  readonly exactLogCursors?: boolean;
}): FakeChain {
  const blocks: FakeBlock[] = [
    {
      height: options.baseHeight,
      hash: `0x${options.baseHeight}`,
      parentHash: `0x${options.baseHeight - 1}`,
      blockTime: options.baseHeight * 10,
      transactions: [],
    },
  ];

  const requests: string[] = [];
  const failures = new Map<string, number>();
  const staleHeads: number[] = [];
  let fork = 0;

  const tip = () => blocks[blocks.length - 1];

  const findBlock = (heightOrHash: string) =>
    blocks.find((block) =>
      heightOrHash.startsWith("0x")
        ? block.hash === heightOrHash
        : block.height === Number(heightOrHash),
    );

  const findTransaction = (txId: string) => {
    for (const block of blocks) {
      const txIndex = block.transactions.findIndex((transaction) => transaction.txId === txId);

      if (txIndex !== -1) {
        return { block, txIndex };
      }
    }

    return undefined;
  };

  const logEntries = (contractId: string): LogEntry[] => {
    const entries: LogEntry[] = [];

    for (const block of blocks) {
      block.transactions.forEach((transaction, txIndex) => {
        if (!isSuccess(transaction)) {
          return;
        }

        for (const event of transaction.events) {
          if (event.contractId === contractId) {
            entries.push({ block, txIndex, transaction, event });
          }
        }
      });
    }

    // Newest first, as served by the logs endpoint.
    return entries.toReversed();
  };

  const contractLogs = (contractId: string, params: URLSearchParams) => {
    const limit = Number(params.get("limit") ?? 20);
    const cursor = params.get("cursor");
    const entries = logEntries(contractId);

    const firstAtCursor =
      cursor === null ? 0 : entries.findIndex((entry) => isAtOrBelowCursor(entry, cursor));

    const isUnknownCursor =
      cursor !== null &&
      (firstAtCursor === -1 ||
        (options.exactLogCursors === true && logCursor(entries[firstAtCursor]) !== cursor));

    // `404 Cursor not found`: no event at or below the cursor.
    if (isUnknownCursor) {
      return json({ error: "Cursor not found" }, 404);
    }

    const start = firstAtCursor;
    const page = entries.slice(start, start + limit);
    const older = entries.at(start + limit);
    const newer = start - limit >= 0 ? entries[start - limit] : undefined;

    return json({
      limit,
      offset: 0,
      total: entries.length,
      cursor: page[0] === undefined ? null : logCursor(page[0]),
      next_cursor: newer === undefined ? null : logCursor(newer),
      prev_cursor: older === undefined ? null : logCursor(older),
      results: page.map((entry) => ({
        event_index: entry.event.eventIndex,
        event_type: "smart_contract_log",
        tx_id: entry.transaction.txId,
        contract_log: contractLogValue(entry.event),
      })),
    });
  };

  const listBlocks = (chain: FakeChain, params: URLSearchParams) => {
    const limit = Number(params.get("limit") ?? 20);
    const offset = Number(params.get("offset") ?? 0);

    if (limit === 1 && offset === 0) {
      chain.onHeadPoll?.();

      const staleHeight = staleHeads.shift();

      if (staleHeight !== undefined) {
        const stale = findBlock(String(staleHeight));

        return json({
          limit,
          offset,
          total: blocks.length,
          results: stale === undefined ? [] : [blockRow(stale)],
        });
      }
    }

    return json({
      limit,
      offset,
      total: blocks.length,
      results: blocks
        .toReversed()
        .slice(offset, offset + limit)
        .map((block) => blockRow(block)),
    });
  };

  const route = (chain: FakeChain, url: URL) => {
    const path = url.pathname;
    const params = url.searchParams;

    if (path === "/extended") {
      return json({ chain_tip: { block_height: tip().height, block_hash: tip().hash } });
    }

    if (path === "/extended/v2/blocks") {
      return listBlocks(chain, params);
    }

    const block = /^\/extended\/v2\/blocks\/(?<id>[^/]+)$/u.exec(path)?.groups?.id;

    if (block !== undefined) {
      const found = findBlock(block);

      return found === undefined ? notFound() : json(blockRow(found));
    }

    const logsContract = /^\/extended\/v2\/smart-contracts\/(?<id>[^/]+)\/logs$/u.exec(path)?.groups
      ?.id;

    if (logsContract !== undefined) {
      return contractLogs(logsContract, params);
    }

    if (path === "/extended/v3/transactions/batch") {
      const ids = params.getAll("tx_id").flatMap((value) => value.split(","));

      const results = ids.flatMap((txId) => {
        const located = findTransaction(txId);

        return located === undefined ? [] : [transactionSummary(located.block, located.txIndex)];
      });

      return json({ results });
    }

    const transactionsBlock = /^\/extended\/v3\/blocks\/(?<id>[^/]+)\/transactions$/u.exec(path)
      ?.groups?.id;

    if (transactionsBlock !== undefined) {
      const found = findBlock(transactionsBlock);

      return found === undefined
        ? notFound()
        : offsetPage(
            found.transactions.map((_, txIndex) => transactionSummary(found, txIndex)),
            params,
          );
    }

    const eventsTransaction = /^\/extended\/v3\/transactions\/(?<id>[^/]+)\/events$/u.exec(path)
      ?.groups?.id;

    if (eventsTransaction !== undefined) {
      const located = findTransaction(eventsTransaction);

      return located === undefined
        ? notFound()
        : offsetPage(transactionEvents(located.block.transactions[located.txIndex]), params);
    }

    return notFound();
  };

  const chain: FakeChain = {
    blocks,
    requests,
    failures,
    staleHeads,
    onHeadPoll: undefined,
    mine: (transactions = []) => {
      const height = tip().height + 1;

      blocks.push({
        height,
        hash: fork === 0 ? `0x${height}` : `0x${height}-fork${fork}`,
        parentHash: tip().hash,
        blockTime: height * 10,
        transactions,
      });
    },
    orphanFrom: (height) => {
      while (tip().height >= height) {
        blocks.pop();
      }

      fork += 1;
    },
    fetch: (input) => {
      const url = new URL(input instanceof Request ? input.url : input);

      requests.push(decodeURIComponent(`${url.pathname}${url.search}`));

      for (const [prefix, remaining] of failures) {
        if (remaining > 0 && url.pathname.startsWith(prefix)) {
          failures.set(prefix, remaining - 1);

          return Promise.resolve(notFound());
        }
      }

      return Promise.resolve(route(chain, url));
    },
  };

  return chain;
}
