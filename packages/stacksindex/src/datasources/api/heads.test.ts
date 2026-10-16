import { Effect, Exit, Fiber, Logger, Queue, Stream } from "effect";
import { HttpClientError, HttpClientRequest } from "effect/http";
import { Socket } from "effect/socket";
import { TestClock } from "effect/testing";
import { describe, expect, test } from "vite-plus/test";

import {
  type BlockHeadsConfig,
  blockHeads,
  defaultWebSocketUrl,
  type LightBlock,
} from "./heads.ts";
import {
  type BlocksApiResponse,
  StacksClient,
  type StacksClientService,
  type StacksHttpError,
} from "./index.ts";

const CHAIN_ID = 1;

const WEB_SOCKET_URL = "wss://api.example.com/extended/v1/ws";

const SUBSCRIBE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "subscribe",
  params: { event: "block" },
};

const pollingConfig: BlockHeadsConfig = {
  chainId: CHAIN_ID,
  transport: "polling",
  pollingInterval: 1000,
  webSocketUrl: WEB_SOCKET_URL,
};

const webSocketConfig: BlockHeadsConfig = { ...pollingConfig, transport: "websocket" };

/** The `GET /extended/v2/blocks` row fields heads read. */
type HeadRow = Pick<
  BlocksApiResponse["results"][number],
  | "canonical"
  | "height"
  | "hash"
  | "parent_block_hash"
  | "block_time"
  | "tenure_height"
  | "tx_count"
>;

const blockRow = (height: number, hash: string): HeadRow => ({
  canonical: true,
  height,
  hash,
  parent_block_hash: `0xparent${height}`,
  block_time: 1_792_000_000 + height,
  tenure_height: 259_000 + height,
  tx_count: 3,
});

const lightBlock = (height: number, hash: string, txCount = 3): LightBlock => ({
  height,
  hash,
  parentHash: `0xparent${height}`,
  blockTime: 1_792_000_000 + height,
  tenureHeight: 259_000 + height,
  txCount,
});

/** Hiro `block` notification frame as observed on `wss://api.hiro.so/extended/v1/ws`. */
const blockNotification = (height: number, hash: string, txs: string[]) =>
  JSON.stringify({
    jsonrpc: "2.0",
    method: "block",
    params: {
      canonical: true,
      height,
      hash,
      block_time: 1_792_000_000 + height,
      block_time_iso: "2026-10-15T21:53:58.000Z",
      tenure_height: 259_000 + height,
      index_block_hash: `0xindex${height}`,
      parent_block_hash: `0xparent${height}`,
      burn_block_height: 971_626,
      miner_txid: "0xminer",
      txs,
    },
  });

const unavailable = () => {
  const request = HttpClientRequest.get("https://api.example.com/extended/v2/blocks");

  return new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: "connection refused" }),
  });
};

const notUsed = () => Effect.die("StacksClient method not used in this test");

const makeClient = (getBlocks: StacksClientService["getBlocks"]): StacksClientService => ({
  getStatus: notUsed,
  getBlocks,
  getBlock: notUsed,
  getBlockTransactions: notUsed,
  getTransaction: notUsed,
  getV1Transaction: notUsed,
  getTransactionsBatch: notUsed,
  getTransactionEvents: notUsed,
  getPrincipalTransactions: notUsed,
  getContract: notUsed,
  getContractLogs: notUsed,
  callReadFunction: notUsed,
});

// SAFETY: Heads read only `results[0]`, built by `blockRow`.
const blocksPage = (row: HeadRow): BlocksApiResponse => ({ results: [row] }) as never;

/** Serves `tip.row` as the chain tip and counts polls. */
const makeTip = (row: HeadRow) => {
  const tip = { row, polls: 0 };

  const client = makeClient((options) =>
    Effect.sync(() => {
      expect(options).toStrictEqual({ limit: 1 });
      tip.polls += 1;

      return blocksPage(tip.row);
    }),
  );

  return { tip, client };
};

/** Answers poll `n` with `responses[n]`, repeating the last response. */
const makeScriptedClient = (
  responses: readonly Effect.Effect<BlocksApiResponse, StacksHttpError>[],
) => {
  const script = { polls: 0 };

  const client = makeClient(() =>
    Effect.suspend(() => {
      const response =
        responses[Math.min(script.polls, responses.length - 1)] ??
        Effect.die("No scripted response");

      script.polls += 1;

      return response;
    }),
  );

  return { script, client };
};

type Listener = (event: Socket.WebSocketEvent) => void;

/** In-memory websocket driven by the test through `open`, `receive` and `drop`. */
class FakeWebSocket implements Socket.WebSocketLike {
  readyState = 0;
  readonly url: string;
  readonly sent = Effect.runSync(Queue.unbounded<string>());
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set();

    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string | Uint8Array<ArrayBuffer>): void {
    Queue.offerUnsafe(this.sent, String(data));
  }

  close(code = 1000): void {
    if (this.readyState < 2) {
      this.readyState = 3;
      this.dispatch("close", { code });
    }
  }

  open(): void {
    this.readyState = 1;
    this.dispatch("open", {});
  }

  receive(data: string): void {
    this.dispatch("message", { data });
  }

  /** Server-side abnormal close. */
  drop(): void {
    this.close(1006);
  }

  private dispatch(type: string, event: Socket.WebSocketEvent): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

interface CapturedLog {
  level: string;
  message: unknown;
  annotations: Record<string, string | number | boolean>;
}

interface Harness {
  readonly logs: CapturedLog[];
  readonly sockets: Queue.Queue<FakeWebSocket>;
  readonly emitted: Queue.Queue<LightBlock>;
  /** Takes captured logs until one with `message`. */
  readonly awaitLog: (message: string) => Effect.Effect<CapturedLog>;
}

/**
 * Runs `blockHeads(config)` in the background under a `TestClock`, exposing
 * emitted heads, created websockets and captured logs to `body`.
 */
const runHeads = <A>(
  config: BlockHeadsConfig,
  client: StacksClientService,
  body: (harness: Harness, heads: Fiber.Fiber<void, unknown>) => Effect.Effect<A>,
) => {
  const logs: CapturedLog[] = [];
  const logQueue = Effect.runSync(Queue.unbounded<CapturedLog>());
  const sockets = Effect.runSync(Queue.unbounded<FakeWebSocket>());
  const emitted = Effect.runSync(Queue.unbounded<LightBlock>());

  const capture = Logger.make((options) => {
    const output = Logger.formatStructured.log(options);

    const log: CapturedLog = {
      level: output.level,
      message: output.message,
      // SAFETY: `formatStructured` exposes annotations as an untyped record; these tests read known keys.
      annotations: output.annotations as Record<string, string | number | boolean>,
    };

    logs.push(log);
    Queue.offerUnsafe(logQueue, log);
  });

  const awaitLog = (message: string) =>
    Effect.gen(function* () {
      for (;;) {
        const log = yield* Queue.take(logQueue);

        if (log.message === message) {
          return log;
        }
      }
    });

  return Effect.runPromise(
    Effect.gen(function* () {
      const heads = yield* Effect.forkChild(
        blockHeads(config).pipe(Stream.runForEach((head) => Queue.offer(emitted, head))),
      );

      return yield* body({ logs, sockets, emitted, awaitLog }, heads);
    }).pipe(
      Effect.provideService(StacksClient, StacksClient.of(client)),
      Effect.provideService(Socket.WebSocketConstructor, (url) => {
        const socket = new FakeWebSocket(url);

        Queue.offerUnsafe(sockets, socket);

        return socket;
      }),
      Effect.provide(TestClock.layer()),
      Effect.provide(Logger.layer([capture])),
    ),
  );
};

describe("blockHeads polling", () => {
  test("emits the first head immediately and skips polls returning the same hash", async () => {
    const { tip, client } = makeTip(blockRow(10, "0xa"));

    await runHeads(pollingConfig, client, ({ emitted }) =>
      Effect.gen(function* () {
        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(10, "0xa"));
        expect(tip.polls).toBe(1);

        yield* TestClock.adjust(1000);
        tip.row = blockRow(11, "0xb");
        yield* TestClock.adjust(1000);

        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(11, "0xb"));
        expect(tip.polls).toBe(3);
      }),
    );
  });

  test("logs a failed poll and recovers at the next interval", async () => {
    const { script, client } = makeScriptedClient([
      Effect.fail(unavailable()),
      Effect.succeed(blocksPage(blockRow(10, "0xa"))),
    ]);

    await runHeads(pollingConfig, client, ({ emitted, awaitLog }) =>
      Effect.gen(function* () {
        const warning = yield* awaitLog("Failed to poll the latest block");

        expect(warning.level).toBe("WARN");
        expect(warning.annotations).toMatchObject({
          chainId: CHAIN_ID,
          phase: "heads",
          error: expect.stringContaining("connection refused"),
          retryCount: 1,
        });

        yield* TestClock.adjust(1000);

        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(10, "0xa"));
        expect(script.polls).toBe(2);
      }),
    );
  });

  test("fails only after 10 consecutive failed polls spanning 10 minutes", async () => {
    const error = unavailable();
    const { script, client } = makeScriptedClient([Effect.fail(error)]);

    await runHeads({ ...pollingConfig, pollingInterval: 60_000 }, client, ({ awaitLog }, heads) =>
      Effect.gen(function* () {
        for (let minute = 1; minute < 10; minute += 1) {
          yield* awaitLog("Failed to poll the latest block");
          yield* TestClock.adjust(60_000);
        }

        yield* awaitLog("Failed to poll the latest block");

        // Ten failures within nine minutes: still within budget.
        expect(heads.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust(60_000);

        const exit = yield* Fiber.await(heads);

        expect(exit).toStrictEqual(Exit.fail(error));
        expect(script.polls).toBe(11);
      }),
    );
  });

  test("warns once per stall when no new head arrives for 30s", async () => {
    const { tip, client } = makeTip(blockRow(10, "0xa"));

    await runHeads(
      { ...pollingConfig, pollingInterval: 10_000 },
      client,
      ({ emitted, logs, awaitLog }) =>
        Effect.gen(function* () {
          yield* Queue.take(emitted);
          yield* TestClock.adjust(30_000);

          const stall = yield* awaitLog("No new block for 30s");

          expect(stall.level).toBe("WARN");
          expect(stall.annotations).toMatchObject({
            chainId: CHAIN_ID,
            phase: "heads",
            lastHeight: 10,
          });

          yield* TestClock.adjust(30_000);
          tip.row = blockRow(11, "0xb");
          yield* TestClock.adjust(10_000);
          yield* Queue.take(emitted);
          yield* TestClock.adjust(30_000);

          const nextStall = yield* awaitLog("No new block for 30s");

          expect(nextStall.annotations).toMatchObject({ lastHeight: 11 });
          expect(logs.filter((log) => log.message === "No new block for 30s")).toHaveLength(2);
        }),
    );
  });
});

describe("blockHeads websocket", () => {
  test("subscribes, maps block notifications and catches up after reconnecting", async () => {
    const { tip, client } = makeTip(blockRow(10, "0xa"));

    await runHeads(webSocketConfig, client, ({ sockets, emitted, awaitLog }) =>
      Effect.gen(function* () {
        const first = yield* Queue.take(sockets);

        expect(first.url).toBe(WEB_SOCKET_URL);
        first.open();
        expect(JSON.parse(yield* Queue.take(first.sent))).toStrictEqual(SUBSCRIBE_REQUEST);
        // The connection polls once to recover heads missed while disconnected.
        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(10, "0xa"));

        first.receive(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
        first.receive(blockNotification(11, "0xb", ["0xtx1", "0xtx2"]));

        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(11, "0xb", 2));

        tip.row = blockRow(12, "0xc");
        first.drop();

        const warning = yield* awaitLog("Block subscription failed; reconnecting");

        expect(warning.annotations).toMatchObject({
          chainId: CHAIN_ID,
          phase: "heads",
          retryCount: 1,
          retryDelayMs: 250,
        });

        yield* TestClock.adjust(249);
        expect(yield* Queue.size(sockets)).toBe(0);
        yield* TestClock.adjust(1);

        const second = yield* Queue.take(sockets);

        second.open();
        expect(JSON.parse(yield* Queue.take(second.sent))).toStrictEqual(SUBSCRIBE_REQUEST);
        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(12, "0xc"));
      }),
    );
  });

  test("counts JSON-RPC errors and malformed messages as failures until a notification arrives", async () => {
    const { client } = makeTip(blockRow(10, "0xa"));

    await runHeads(webSocketConfig, client, ({ sockets, awaitLog }) =>
      Effect.gen(function* () {
        const rejected = yield* Queue.take(sockets);

        rejected.open();
        yield* Queue.take(rejected.sent);
        rejected.receive(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { code: -32_602, message: "Invalid params" },
          }),
        );

        const rejection = yield* awaitLog("Block subscription failed; reconnecting");

        expect(rejection.annotations).toMatchObject({
          error: expect.stringContaining("Invalid params"),
          retryCount: 1,
          retryDelayMs: 250,
        });
        yield* TestClock.adjust(250);

        const malformed = yield* Queue.take(sockets);

        malformed.open();
        yield* Queue.take(malformed.sent);
        malformed.receive("not json");

        expect(
          (yield* awaitLog("Block subscription failed; reconnecting")).annotations,
        ).toMatchObject({ retryCount: 2, retryDelayMs: 500 });
        yield* TestClock.adjust(500);

        const healthy = yield* Queue.take(sockets);

        healthy.open();
        yield* Queue.take(healthy.sent);
        healthy.receive(blockNotification(11, "0xb", []));
        healthy.drop();

        expect(
          (yield* awaitLog("Block subscription failed; reconnecting")).annotations,
        ).toMatchObject({ retryCount: 1, retryDelayMs: 250 });
      }),
    );
  });

  test("falls back to polling after 9 consecutive failures", async () => {
    const { tip, client } = makeTip(blockRow(10, "0xa"));

    await runHeads(webSocketConfig, client, ({ sockets, emitted, awaitLog }) =>
      Effect.gen(function* () {
        for (let failure = 1; failure < 9; failure += 1) {
          (yield* Queue.take(sockets)).drop();
          yield* awaitLog("Block subscription failed; reconnecting");
          yield* TestClock.adjust(125 * 2 ** failure);
        }

        (yield* Queue.take(sockets)).drop();

        const fallback = yield* awaitLog(
          "Block subscription failed 9 consecutive times; falling back to polling",
        );

        expect(fallback.level).toBe("WARN");
        expect(fallback.annotations).toMatchObject({ chainId: CHAIN_ID, phase: "heads" });
        // No connection ever opened, so every poll comes from the fallback.
        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(10, "0xa"));
        expect(tip.polls).toBe(1);

        tip.row = blockRow(11, "0xb");
        yield* TestClock.adjust(webSocketConfig.pollingInterval);

        expect(yield* Queue.take(emitted)).toStrictEqual(lightBlock(11, "0xb"));
        expect(tip.polls).toBe(2);
        expect(yield* Queue.size(sockets)).toBe(0);
      }),
    );
  });
});

describe("default websocket URL", () => {
  test.each([
    ["https://api.hiro.so", "wss://api.hiro.so/extended/v1/ws"],
    ["https://api.testnet.hiro.so/", "wss://api.testnet.hiro.so/extended/v1/ws"],
    ["http://localhost:3999", "ws://localhost:3999/extended/v1/ws"],
    ["https://proxy.example.com/stacks/", "wss://proxy.example.com/stacks/extended/v1/ws"],
  ])("maps %s to %s", (baseUrl, expected) => {
    expect(defaultWebSocketUrl(baseUrl)).toBe(expected);
  });
});
