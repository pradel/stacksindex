import { eq } from "drizzle-orm";
import type { EventHandler, IndexerDb, IndexingClient, Logger } from "stacksindex";
import { decodeHex } from "stacksindex/clarity";
import { z } from "zod";

import { fixedWeightPoolAbi, sip010Abi } from "./abi.ts";
import { poolTable, type relations, swapTable, type Token, tokenTable } from "./schema.ts";

/** `context.db`: the indexer database, scoped to the batch transaction and typed with `relations`. */
export type AppDatabase = IndexerDb<typeof relations>;

export const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

export const CHAIN_ID = 1n;

// Zod schemas for contract log events (validating decoded JSON object)
export const poolCreatedLogSchema = z
  .object({
    object: z.literal("pool"),
    action: z.literal("created"),
    data: z.object({
      "pool-token": z.string(),
      "balance-x": z.bigint().optional().default(0n),
      "balance-y": z.bigint().optional().default(0n),
      "total-supply": z.bigint().optional().default(0n),
      "fee-rate-x": z.bigint().optional().default(0n),
      "fee-rate-y": z.bigint().optional().default(0n),
      "fee-to-address": z.string().optional().default(""),
      "oracle-enabled": z.boolean().optional().default(false),
    }),
  })
  .transform((val) => ({
    action: "created" as const,
    poolToken: val.data["pool-token"],
    balanceX: val.data["balance-x"],
    balanceY: val.data["balance-y"],
    totalSupply: val.data["total-supply"],
    feeRateX: val.data["fee-rate-x"],
    feeRateY: val.data["fee-rate-y"],
    feeToAddress: val.data["fee-to-address"],
    oracleEnabled: val.data["oracle-enabled"],
  }));

export const poolSwapLogSchema = z
  .object({
    object: z.literal("pool"),
    action: z.union([z.literal("swap-x-for-y"), z.literal("swap-y-for-x")]),
    data: z.object({
      "pool-token": z.string(),
      "balance-x": z.bigint(),
      "balance-y": z.bigint(),
      "total-supply": z.bigint(),
    }),
  })
  .transform((val) => ({
    action: val.action,
    poolToken: val.data["pool-token"],
    balanceX: val.data["balance-x"],
    balanceY: val.data["balance-y"],
    totalSupply: val.data["total-supply"],
  }));

// The pool prints `liquidity-added` / `liquidity-removed` when liquidity moves.
const otherPoolActionSchema = z.union([
  z.literal("liquidity-added"),
  z.literal("liquidity-removed"),
  z.literal("add-to-position"),
  z.literal("reduce-position"),
  z.literal("set-fee-to-address"),
  z.literal("set-fee-rate-x"),
  z.literal("set-fee-rate-y"),
  z.literal("set-oracle-enabled"),
  z.literal("set-oracle-average"),
]);

export const poolBalanceChangeLogSchema = z
  .object({
    object: z.literal("pool"),
    action: otherPoolActionSchema,
    data: z.object({
      "pool-token": z.string(),
      "balance-x": z.bigint(),
      "balance-y": z.bigint(),
      "total-supply": z.bigint(),
    }),
  })
  .transform((val) => ({
    action: val.action,
    poolToken: val.data["pool-token"],
    balanceX: val.data["balance-x"],
    balanceY: val.data["balance-y"],
    totalSupply: val.data["total-supply"],
  }));

export const poolLogSchema = z.union([
  poolCreatedLogSchema,
  poolSwapLogSchema,
  poolBalanceChangeLogSchema,
]);

export type PoolLog = z.infer<typeof poolLogSchema>;

export interface InsertTokenIfNotExistsParams {
  client: IndexingClient;
  logger: Logger;
  db: AppDatabase;
  chainId: bigint;
  tokenAddress: string;
}

export async function insertTokenIfNotExists({
  client,
  logger,
  db,
  chainId,
  tokenAddress,
}: InsertTokenIfNotExistsParams): Promise<Token> {
  const existing = await db.query.token.findFirst({ where: { address: tokenAddress } });

  if (existing) {
    return existing;
  }

  if (!tokenAddress.includes(".")) {
    throw new Error(`Invalid tokenAddress: ${tokenAddress}`);
  }

  const decimalsRes = await client.callReadOnly({
    abi: sip010Abi,
    contractId: tokenAddress,
    functionName: "get-decimals",
  });

  const symbolRes = await client.callReadOnly({
    abi: sip010Abi,
    contractId: tokenAddress,
    functionName: "get-symbol",
  });

  if (decimalsRes.ok === undefined) {
    throw new Error(
      `Failed to fetch decimals for token ${tokenAddress}: contract returned error ${decimalsRes.error}`,
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

  await db.insert(tokenTable).values(token).onConflictDoNothing();

  logger.info("Discovered token", { token: tokenAddress, symbol, decimals });

  return token;
}

export interface SyncPoolTokensParams {
  client: IndexingClient;
  logger: Logger;
  db: AppDatabase;
  chainId: bigint;
  poolContract: string;
  poolToken: string;
}

export async function syncPoolTokens({
  client,
  logger,
  db,
  chainId,
  poolContract,
  poolToken,
}: SyncPoolTokensParams): Promise<void> {
  if (!poolContract.includes(".")) {
    throw new Error(`Invalid poolContract: ${poolContract}`);
  }

  const poolId = await client.callReadOnly({
    abi: fixedWeightPoolAbi,
    contractId: poolContract,
    functionName: "get-pool-count",
  });

  if (poolId === 0n) {
    throw new Error(`Failed to fetch pool count from ${poolContract}: pool count is 0`);
  }

  const contractsResult = await client.callReadOnly({
    abi: fixedWeightPoolAbi,
    contractId: poolContract,
    functionName: "get-pool-contracts",
    functionArgs: [poolId],
  });

  if (contractsResult.ok === undefined) {
    throw new Error(
      `Failed to fetch pool contracts for pool ${poolToken} (poolId: ${poolId}): contract returned error ${contractsResult.error}`,
    );
  }

  const tokenX = contractsResult.ok["token-x"];
  const tokenY = contractsResult.ok["token-y"];

  await insertTokenIfNotExists({
    client,
    logger,
    db,
    chainId,
    tokenAddress: tokenX,
  });

  await insertTokenIfNotExists({
    client,
    logger,
    db,
    chainId,
    tokenAddress: tokenY,
  });

  await db.update(poolTable).set({ tokenX, tokenY }).where(eq(poolTable.address, poolToken));
}

interface UpsertPoolBalancesParams {
  db: AppDatabase;
  poolToken: string;
  chainId: bigint;
  balanceX: bigint;
  balanceY: bigint;
  totalSupply: bigint;
  blockTime: number;
}

async function upsertPoolBalances({
  db,
  poolToken,
  chainId,
  balanceX,
  balanceY,
  totalSupply,
  blockTime,
}: UpsertPoolBalancesParams): Promise<void> {
  await db
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
    });
}

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
  return async (event, { client, logger, db }) => {
    const decoded = decodeHex(event.contract_log.value.hex);
    const parsed = poolLogSchema.safeParse(decoded);

    if (!parsed.success) {
      return;
    }

    const log = parsed.data;

    if (log.action === "created") {
      await db
        .insert(poolTable)
        .values({
          address: log.poolToken,
          chainId,
          balanceX: 0n,
          balanceY: 0n,
          totalSupply: 0n,
          feeRateX: log.feeRateX,
          feeRateY: log.feeRateY,
          feeToAddress: log.feeToAddress,
          oracleEnabled: log.oracleEnabled,
          createdAt: BigInt(event.block_time),
        })
        .onConflictDoUpdate({
          target: [poolTable.address, poolTable.chainId],
          set: {
            feeRateX: log.feeRateX,
            feeRateY: log.feeRateY,
            feeToAddress: log.feeToAddress,
            oracleEnabled: log.oracleEnabled,
          },
        });

      await syncPoolTokens({
        client,
        logger,
        db,
        chainId,
        poolContract,
        poolToken: log.poolToken,
      });

      logger.debug("Pool created", { pool: log.poolToken });
    } else if (log.action === "swap-x-for-y" || log.action === "swap-y-for-x") {
      const pool = await db.query.pool.findFirst({ where: { address: log.poolToken } });

      let amountIn = 0n;
      let amountOut = 0n;

      if (pool) {
        if (log.action === "swap-x-for-y") {
          amountIn = log.balanceX - pool.balanceX;
          amountOut = pool.balanceY - log.balanceY;
        } else {
          amountIn = log.balanceY - pool.balanceY;
          amountOut = pool.balanceX - log.balanceX;
        }
      }

      await db
        .insert(swapTable)
        .values({
          txId: event.tx_id,
          chainId,
          eventIndex: event.event_index,
          poolAddress: log.poolToken,
          action: log.action,
          amountIn,
          amountOut,
          blockHeight: BigInt(event.block_height),
          blockTime: BigInt(event.block_time),
        })
        .onConflictDoNothing();

      logger.debug("Swap created", {
        pool: log.poolToken,
        action: log.action,
        amountIn,
        amountOut,
        txId: event.tx_id,
      });

      await upsertPoolBalances({
        db,
        poolToken: log.poolToken,
        chainId,
        balanceX: log.balanceX,
        balanceY: log.balanceY,
        totalSupply: log.totalSupply,
        blockTime: event.block_time,
      });

      if (pool && (!pool.tokenX || !pool.tokenY)) {
        await syncPoolTokens({
          client,
          logger,
          db,
          chainId,
          poolContract,
          poolToken: log.poolToken,
        });
      }
    } else {
      // Liquidity added / removed or other pool balance changes
      await upsertPoolBalances({
        db,
        poolToken: log.poolToken,
        chainId,
        balanceX: log.balanceX,
        balanceY: log.balanceY,
        totalSupply: log.totalSupply,
        blockTime: event.block_time,
      });
    }
  };
}
