import { eq } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
  decodeHex,
  type EventHandler,
  type IndexerDb,
  type IndexingClient,
} from "stacksindex/effect";

import { fixedWeightPoolAbi, sip010Abi } from "./abi.ts";
import { poolTable, type relations, swapTable, type Token, tokenTable } from "./schema.ts";

/** `context.db`: the indexer database, scoped to the batch transaction and typed with `relations`. */
export type AppDatabase = IndexerDb<typeof relations>;

export const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

export const CHAIN_ID = 1n;

// Effect schemas for contract log events (validating decoded JSON object)
export const PoolCreatedLog = Schema.Struct({
  object: Schema.Literal("pool"),
  action: Schema.Literal("created"),
  data: Schema.Struct({
    "pool-token": Schema.String,
    "balance-x": Schema.optional(Schema.BigInt),
    "balance-y": Schema.optional(Schema.BigInt),
    "total-supply": Schema.optional(Schema.BigInt),
    "fee-rate-x": Schema.optional(Schema.BigInt),
    "fee-rate-y": Schema.optional(Schema.BigInt),
    "fee-to-address": Schema.optional(Schema.String),
    "oracle-enabled": Schema.optional(Schema.Boolean),
  }),
});

export const PoolSwapLog = Schema.Struct({
  object: Schema.Literal("pool"),
  action: Schema.Union([Schema.Literal("swap-x-for-y"), Schema.Literal("swap-y-for-x")]),
  data: Schema.Struct({
    "pool-token": Schema.String,
    "balance-x": Schema.BigInt,
    "balance-y": Schema.BigInt,
    "total-supply": Schema.BigInt,
  }),
});

// The pool prints `liquidity-added` / `liquidity-removed` when liquidity moves.
const OtherPoolAction = Schema.Union([
  Schema.Literal("liquidity-added"),
  Schema.Literal("liquidity-removed"),
  Schema.Literal("add-to-position"),
  Schema.Literal("reduce-position"),
  Schema.Literal("set-fee-to-address"),
  Schema.Literal("set-fee-rate-x"),
  Schema.Literal("set-fee-rate-y"),
  Schema.Literal("set-oracle-enabled"),
  Schema.Literal("set-oracle-average"),
]);

export const PoolBalanceChangeLog = Schema.Struct({
  object: Schema.Literal("pool"),
  action: OtherPoolAction,
  data: Schema.Struct({
    "pool-token": Schema.String,
    "balance-x": Schema.BigInt,
    "balance-y": Schema.BigInt,
    "total-supply": Schema.BigInt,
  }),
});

export const PoolLog = Schema.Union([PoolCreatedLog, PoolSwapLog, PoolBalanceChangeLog]);

export type PoolLogData = typeof PoolLog.Type;

export interface InsertTokenIfNotExistsParams {
  client: IndexingClient;
  db: AppDatabase;
  chainId: bigint;
  tokenAddress: string;
}

export const insertTokenIfNotExists = ({
  client,
  db,
  chainId,
  tokenAddress,
}: InsertTokenIfNotExistsParams) =>
  Effect.gen(function* () {
    const existing = yield* db.query.token.findFirst({ where: { address: tokenAddress } });

    if (existing) {
      return existing;
    }

    if (!tokenAddress.includes(".")) {
      return yield* Effect.fail(new Error(`Invalid tokenAddress: ${tokenAddress}`));
    }

    const decimalsRes = yield* client.callReadOnly({
      abi: sip010Abi,
      contractId: tokenAddress,
      functionName: "get-decimals",
    });

    const symbolRes = yield* client.callReadOnly({
      abi: sip010Abi,
      contractId: tokenAddress,
      functionName: "get-symbol",
    });

    if (decimalsRes.ok === undefined) {
      return yield* Effect.fail(
        new Error(
          `Failed to fetch decimals for token ${tokenAddress}: contract returned error ${decimalsRes.error}`,
        ),
      );
    }

    const decimals = Number(decimalsRes.ok);
    const symbol = symbolRes.ok ?? "???";

    const token: Token = {
      address: tokenAddress,
      chainId,
      symbol,
      decimals,
    };

    yield* db.insert(tokenTable).values(token).onConflictDoNothing();

    yield* Effect.logInfo("Discovered token").pipe(
      Effect.annotateLogs({ token: tokenAddress, symbol, decimals }),
    );

    return token;
  });

export interface SyncPoolTokensParams {
  client: IndexingClient;
  db: AppDatabase;
  chainId: bigint;
  poolContract: string;
  poolToken: string;
}

export const syncPoolTokens = ({
  client,
  db,
  chainId,
  poolContract,
  poolToken,
}: SyncPoolTokensParams) =>
  Effect.gen(function* () {
    if (!poolContract.includes(".")) {
      return yield* Effect.fail(new Error(`Invalid poolContract: ${poolContract}`));
    }

    const poolId = yield* client.callReadOnly({
      abi: fixedWeightPoolAbi,
      contractId: poolContract,
      functionName: "get-pool-count",
    });

    if (poolId === 0n) {
      return yield* Effect.fail(
        new Error(`Failed to fetch pool count from ${poolContract}: pool count is 0`),
      );
    }

    const contractsResult = yield* client.callReadOnly({
      abi: fixedWeightPoolAbi,
      contractId: poolContract,
      functionName: "get-pool-contracts",
      functionArgs: [poolId],
    });

    if (contractsResult.ok === undefined) {
      return yield* Effect.fail(
        new Error(
          `Failed to fetch pool contracts for pool ${poolToken} (poolId: ${poolId}): contract returned error ${contractsResult.error}`,
        ),
      );
    }

    const tokenX = contractsResult.ok["token-x"];
    const tokenY = contractsResult.ok["token-y"];

    yield* insertTokenIfNotExists({
      client,
      db,
      chainId,
      tokenAddress: tokenX,
    });

    yield* insertTokenIfNotExists({
      client,
      db,
      chainId,
      tokenAddress: tokenY,
    });

    yield* db.update(poolTable).set({ tokenX, tokenY }).where(eq(poolTable.address, poolToken));
  });

interface UpsertPoolBalancesParams {
  db: AppDatabase;
  poolToken: string;
  chainId: bigint;
  balanceX: bigint;
  balanceY: bigint;
  totalSupply: bigint;
  blockTime: number;
}

const upsertPoolBalances = ({
  db,
  poolToken,
  chainId,
  balanceX,
  balanceY,
  totalSupply,
  blockTime,
}: UpsertPoolBalancesParams) =>
  db
    .insert(poolTable)
    .values({
      address: poolToken,
      chainId,
      balanceX,
      balanceY,
      totalSupply,
      feeRateX: 0n,
      feeRateY: 0n,
      feeToAddress: "",
      oracleEnabled: false,
      createdAt: BigInt(blockTime),
    })
    .onConflictDoUpdate({
      target: [poolTable.address, poolTable.chainId],
      set: {
        balanceX,
        balanceY,
        totalSupply,
      },
    })
    .pipe(Effect.asVoid);

export interface CreatePoolHandlerOptions {
  chainId?: bigint;
  poolContract?: string;
}

/**
 * Writes go through `context.db`, so they commit atomically with the indexer
 * checkpoint. A rewind (chain reorg, or a restart without a sync anchor)
 * re-runs handlers for unfinalized blocks without undoing their writes, so
 * every write is an upsert or insert-if-absent keyed by primary key.
 */
export function createPoolHandler({
  chainId = CHAIN_ID,
  poolContract = POOL_CONTRACT,
}: CreatePoolHandlerOptions = {}): EventHandler<typeof relations> {
  return (event, { client, db }) =>
    Effect.gen(function* () {
      const decoded = decodeHex(event.contract_log.value.hex);
      const parsed = Schema.decodeUnknownOption(PoolLog)(decoded);

      if (Option.isNone(parsed)) {
        return;
      }

      const log = parsed.value;

      if (log.action === "created") {
        const { data } = log;
        const feeRateX = data["fee-rate-x"] ?? 0n;
        const feeRateY = data["fee-rate-y"] ?? 0n;
        const feeToAddress = data["fee-to-address"] ?? "";
        const oracleEnabled = data["oracle-enabled"] ?? false;

        yield* db
          .insert(poolTable)
          .values({
            address: data["pool-token"],
            chainId,
            balanceX: 0n,
            balanceY: 0n,
            totalSupply: 0n,
            feeRateX,
            feeRateY,
            feeToAddress,
            oracleEnabled,
            createdAt: BigInt(event.block_time),
          })
          .onConflictDoUpdate({
            target: [poolTable.address, poolTable.chainId],
            set: {
              feeRateX,
              feeRateY,
              feeToAddress,
              oracleEnabled,
            },
          });

        yield* syncPoolTokens({
          client,
          db,
          chainId,
          poolContract,
          poolToken: data["pool-token"],
        });

        yield* Effect.logDebug("Pool created").pipe(
          Effect.annotateLogs({ pool: data["pool-token"] }),
        );
      } else if (log.action === "swap-x-for-y" || log.action === "swap-y-for-x") {
        const { data } = log;

        const pool = yield* db.query.pool.findFirst({ where: { address: data["pool-token"] } });

        let amountIn = 0n;
        let amountOut = 0n;

        if (pool) {
          if (log.action === "swap-x-for-y") {
            amountIn = data["balance-x"] - pool.balanceX;
            amountOut = pool.balanceY - data["balance-y"];
          } else {
            amountIn = data["balance-y"] - pool.balanceY;
            amountOut = pool.balanceX - data["balance-x"];
          }
        }

        yield* db
          .insert(swapTable)
          .values({
            txId: event.tx_id,
            chainId,
            eventIndex: event.event_index,
            poolAddress: data["pool-token"],
            action: log.action,
            amountIn,
            amountOut,
            blockHeight: BigInt(event.block_height),
            blockTime: BigInt(event.block_time),
          })
          .onConflictDoNothing();

        yield* Effect.logDebug("Swap created").pipe(
          Effect.annotateLogs({
            pool: data["pool-token"],
            action: log.action,
            amountIn,
            amountOut,
            txId: event.tx_id,
          }),
        );

        yield* upsertPoolBalances({
          db,
          poolToken: data["pool-token"],
          chainId,
          balanceX: data["balance-x"],
          balanceY: data["balance-y"],
          totalSupply: data["total-supply"],
          blockTime: event.block_time,
        });

        if (pool && (!pool.tokenX || !pool.tokenY)) {
          yield* syncPoolTokens({
            client,
            db,
            chainId,
            poolContract,
            poolToken: data["pool-token"],
          });
        }
      } else {
        // Liquidity added / removed or other pool balance changes
        const { data } = log;

        yield* upsertPoolBalances({
          db,
          poolToken: data["pool-token"],
          chainId,
          balanceX: data["balance-x"],
          balanceY: data["balance-y"],
          totalSupply: data["total-supply"],
          blockTime: event.block_time,
        });
      }
    });
}
