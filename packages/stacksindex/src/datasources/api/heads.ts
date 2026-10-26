import { Clock, Effect, Metric, Queue, Result, Schema, Stream } from "effect";
import { Socket } from "effect/socket";

import { createFailureBudget } from "../../lib/failure-budget.ts";
import {
  liveHeadBlock,
  liveStalls,
  liveTransportFallbacks,
  liveWebSocketReconnects,
} from "../../lib/metrics.ts";
import {
  type BlocksApiResponse,
  StacksClient,
  type StacksClientService,
  type StacksHttpError,
  type StorableBlock,
} from "./index.ts";

export interface LightBlock {
  readonly height: number;
  readonly hash: string;
  readonly parentHash: string;
  readonly blockTime: number;
  readonly tenureHeight: number;
  /** Transactions in the block; used to estimate per-block fetch cost. */
  readonly txCount: number;
  /**
   * What storing the block needs, carried by `/extended/v2/blocks` rows but
   * not by websocket notifications.
   */
  readonly stored?: StorableBlock;
}

export type HeadsTransport = "polling" | "websocket";

export type BlockHeadsConfig = {
  /** Annotates every log line. */
  readonly chainId: number;
  /** Milliseconds between polls of the latest block. */
  readonly pollingInterval: number;
} & (
  | { readonly transport: "polling" }
  | {
      readonly transport: "websocket";
      /** Hiro JSON-RPC endpoint, e.g. `wss://api.hiro.so/extended/v1/ws`. */
      readonly webSocketUrl: string;
    }
);

type BlockRow = BlocksApiResponse["results"][number];

/**
 * Hiro's websocket `block` notification carries the v1 block shape: the
 * mined transaction ids in `txs` instead of a `tx_count`.
 */
const BlockNotificationSchema = Schema.Struct({
  height: Schema.Number,
  hash: Schema.String,
  parent_block_hash: Schema.String,
  block_time: Schema.Number,
  tenure_height: Schema.Number,
  txs: Schema.Array(Schema.String),
});

type BlockNotification = typeof BlockNotificationSchema.Type;

/** A `/extended/v2/blocks` row or a websocket `block` notification. */
export type LightBlockSource = BlockRow | BlockNotification;

export const toLightBlock = (block: LightBlockSource): LightBlock => {
  const light = {
    height: block.height,
    hash: block.hash,
    parentHash: block.parent_block_hash,
    blockTime: block.block_time,
    tenureHeight: block.tenure_height,
  };

  return "txs" in block
    ? { ...light, txCount: block.txs.length }
    : {
        ...light,
        txCount: block.tx_count,
        stored: {
          height: block.height,
          hash: block.hash,
          index_block_hash: block.index_block_hash,
          burn_block_time: block.burn_block_time,
          burn_block_height: block.burn_block_height,
        },
      };
};

/**
 * Websocket endpoint served next to the API: `https` becomes `wss`, `http`
 * becomes `ws`, and `/extended/v1/ws` is appended to the base path the same
 * way `StacksClient` appends request paths.
 */
export const defaultWebSocketUrl = (baseUrl: string): string => {
  const url = new URL(baseUrl);
  const protocol = url.protocol === "http:" ? "ws:" : "wss:";
  const path = url.pathname.replace(/\/+$/u, "");

  return `${protocol}//${url.host}${path}/extended/v1/ws`;
};

/** Consecutive websocket failures before falling back to polling for good. */
const WEBSOCKET_RETRY_LIMIT = 9;

/** Reconnect delay is `WEBSOCKET_BACKOFF_MS * 2 ** consecutiveFailures`. */
const WEBSOCKET_BACKOFF_MS = 125;

/** A head unchanged for this long is reported as a stall. */
const STALL_MS = 30_000;

const SUBSCRIBE_ID = 1;

const SUBSCRIBE_REQUEST = JSON.stringify({
  jsonrpc: "2.0",
  id: SUBSCRIBE_ID,
  method: "subscribe",
  params: { event: "block" },
});

/** The server rejected the block subscription with a JSON-RPC error. */
class HeadsSubscriptionError extends Schema.TaggedError<HeadsSubscriptionError>()(
  "HeadsSubscriptionError",
  {
    message: Schema.String,
  },
) {}

/** Every message the `block` subscription may receive; anything else breaks the protocol. */
const decodeSubscriptionMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ method: Schema.Literal("block"), params: BlockNotificationSchema }),
      Schema.Struct({
        id: Schema.Number,
        error: Schema.Struct({ code: Schema.Number, message: Schema.String }),
      }),
      Schema.Struct({ id: Schema.Literal(SUBSCRIBE_ID), result: Schema.Unknown }),
    ]),
  ),
);

type Emit = (block: LightBlock) => Effect.Effect<void>;

/** Last emitted head, shared by the emitter and the stall watchdog. */
interface HeadState {
  hash: string | undefined;
  height: number | undefined;
  /** When the last new head was emitted (or the stream started). */
  updatedAt: number;
  stallReported: boolean;
}

/**
 * Polls the latest block immediately and then every `pollingInterval`. A
 * failed poll is retried at the next interval; the source fails only once the
 * failure budget is spent.
 */
const pollHeads = (
  client: StacksClientService,
  pollingInterval: number,
  emit: Emit,
): Effect.Effect<never, StacksHttpError> =>
  Effect.gen(function* () {
    const budget = createFailureBudget();

    for (;;) {
      const result = yield* Effect.result(client.getBlocks({ limit: 1 }));

      if (Result.isSuccess(result)) {
        budget.reset();

        const [latest] = result.success.results;

        if (latest !== undefined) {
          yield* emit(toLightBlock(latest));
        }
      } else {
        if (budget.recordFailure(yield* Clock.currentTimeMillis)) {
          return yield* Effect.fail(result.failure);
        }

        yield* Effect.logWarning("Failed to poll the latest block").pipe(
          Effect.annotateLogs({
            error: String(result.failure),
            retryCount: budget.consecutiveFailures(),
          }),
        );
      }

      yield* Effect.sleep(pollingInterval);
    }
  });

/**
 * Runs one websocket connection: subscribes to `block` notifications, polls
 * once to recover a head missed while disconnected, then emits every
 * notification. Never succeeds: every connection ends with an error.
 */
const subscribeHeads = (
  socket: Socket.Socket,
  client: StacksClientService,
  emit: Emit,
  onNotification: Emit,
) =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket);
    const { write } = yield* socket.writer;

    yield* write(SUBSCRIBE_REQUEST);

    // Recover a head produced while disconnected. Notifications received
    // Meanwhile stay buffered in the reader, so this poll cannot reorder heads.
    const caughtUp = yield* Effect.result(client.getBlocks({ limit: 1 }));

    if (Result.isFailure(caughtUp)) {
      yield* Effect.logWarning("Failed to poll the latest block").pipe(
        Effect.annotateLogs({ error: String(caughtUp.failure) }),
      );
    } else if (caughtUp.success.results[0] !== undefined) {
      yield* emit(toLightBlock(caughtUp.success.results[0]));
    }

    for (;;) {
      const frames = yield* pull;

      for (const frame of frames) {
        const message = yield* decodeSubscriptionMessage(frame);

        if ("method" in message) {
          yield* onNotification(toLightBlock(message.params));
        } else if ("error" in message) {
          return yield* new HeadsSubscriptionError({
            message: `Block subscription failed: ${message.error.message} (${message.error.code})`,
          });
        } else {
          yield* Effect.logDebug("Subscribed to block notifications");
        }
      }
    }
  }).pipe(Effect.scoped);

/**
 * Follows heads over the websocket, reconnecting after
 * `WEBSOCKET_BACKOFF_MS * 2 ** consecutiveFailures`. A notification resets
 * the failure count; after {@link WEBSOCKET_RETRY_LIMIT} consecutive
 * failures the source switches to polling for good.
 */
const webSocketHeads = (
  config: Extract<BlockHeadsConfig, { readonly transport: "websocket" }>,
  client: StacksClientService,
  emit: Emit,
): Effect.Effect<never, StacksHttpError, Socket.WebSocketConstructor> =>
  Effect.gen(function* () {
    const socket = yield* Socket.makeWebSocket(config.webSocketUrl);
    let failures = 0;

    const onNotification: Emit = (block) =>
      Effect.suspend(() => {
        failures = 0;

        return emit(block);
      });

    while (failures < WEBSOCKET_RETRY_LIMIT) {
      const error = yield* Effect.flip(subscribeHeads(socket, client, emit, onNotification));

      failures += 1;

      if (failures < WEBSOCKET_RETRY_LIMIT) {
        const retryDelayMs = WEBSOCKET_BACKOFF_MS * 2 ** failures;

        yield* Effect.logWarning("Block subscription failed; reconnecting").pipe(
          Effect.annotateLogs({ error: String(error), retryCount: failures, retryDelayMs }),
        );
        yield* Metric.update(liveWebSocketReconnects, 1);
        yield* Effect.sleep(retryDelayMs);
      } else {
        yield* Effect.logWarning(
          `Block subscription failed ${WEBSOCKET_RETRY_LIMIT} consecutive times; falling back to polling`,
        ).pipe(Effect.annotateLogs({ error: String(error) }));
        yield* Metric.update(liveTransportFallbacks, 1);
      }
    }

    return yield* pollHeads(client, config.pollingInterval, emit);
  });

/** Warns once per stall when no new head arrived for {@link STALL_MS}. */
const watchStalls = (head: HeadState) =>
  Effect.gen(function* () {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      const stalledAt = head.updatedAt + STALL_MS;

      if (now < stalledAt) {
        yield* Effect.sleep(stalledAt - now);
      } else {
        if (!head.stallReported) {
          head.stallReported = true;
          yield* Effect.logWarning("No new block for 30s").pipe(
            Effect.annotateLogs(head.height === undefined ? {} : { lastHeight: head.height }),
          );
          yield* Metric.update(liveStalls, 1);
        }

        yield* Effect.sleep(STALL_MS);
      }
    }
  });

/**
 * Stream of chain heads, newest first per emission, consecutive duplicates
 * (same hash) removed. Follows the websocket `block` subscription or polls
 * `GET /extended/v2/blocks`, depending on `config.transport`.
 */
export const blockHeads = (
  config: BlockHeadsConfig,
): Stream.Stream<LightBlock, StacksHttpError, StacksClient | Socket.WebSocketConstructor> =>
  Stream.callback<LightBlock, StacksHttpError, StacksClient | Socket.WebSocketConstructor>(
    (queue) =>
      Effect.gen(function* () {
        const client = yield* StacksClient;

        const head: HeadState = {
          hash: undefined,
          height: undefined,
          updatedAt: yield* Clock.currentTimeMillis,
          stallReported: false,
        };

        const emit: Emit = (block) =>
          Effect.gen(function* () {
            if (block.hash === head.hash) {
              return;
            }

            head.hash = block.hash;
            head.height = block.height;
            head.updatedAt = yield* Clock.currentTimeMillis;
            head.stallReported = false;
            yield* Metric.update(liveHeadBlock, block.height);
            yield* Queue.offer(queue, block);
          });

        yield* Effect.forkScoped(watchStalls(head));

        return yield* config.transport === "websocket"
          ? webSocketHeads(config, client, emit)
          : pollHeads(client, config.pollingInterval, emit);
      }).pipe(Effect.annotateLogs({ chainId: config.chainId, phase: "heads" })),
  );
