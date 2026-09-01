import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import { decodeHex, type EventHandler, type IndexingClient, type Logger } from "indexer";
import { z } from "zod";

import { fixedWeightPoolAbi, sip010Abi } from "./abi.ts";
import { poolTable, swapTable, tokenTable } from "./schema.ts";

// oxlint-disable-next-line typescript/no-explicit-any
export type AppDatabase = PgliteDatabase<any>;

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

const otherPoolActionSchema = z.union([
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

export interface DiscoverTokensParams {
  client: IndexingClient;
  db: AppDatabase;
  logger: Logger;
  chainId: bigint;
  tokenAddresses: string[];
}

export async function discoverTokens({
  client,
  db,
  logger,
  chainId,
  tokenAddresses,
}: DiscoverTokensParams): Promise<void> {
  const existingCheck = await Promise.all(
    tokenAddresses.map((addr) =>
      db.select().from(tokenTable).where(eq(tokenTable.address, addr)).limit(1),
    ),
  );

  const missingTokens = tokenAddresses.filter((_addr, idx) => existingCheck[idx].length === 0);

  if (missingTokens.length === 0) {
    return;
  }

  for (const tokenAddress of missingTokens) {
    const [contractAddress, contractName] = tokenAddress.split(".");
    const decimalsRes = await client.callReadOnly({
      abi: sip010Abi,
      contractAddress,
      contractName,
      functionName: "get-decimals",
    });
    if (!decimalsRes.isOk() || decimalsRes.value.ok === undefined) {
      throw new Error(
        `Failed to fetch decimals for token ${tokenAddress}: ${
          decimalsRes.isErr() ? decimalsRes.error.message : "contract call returned error"
        }`,
      );
    }
    const decimals = Number(decimalsRes.value.ok);

    const symbolRes = await client.callReadOnly({
      abi: sip010Abi,
      contractAddress,
      contractName,
      functionName: "get-symbol",
    });
    const symbol =
      symbolRes.isOk() && symbolRes.value.ok !== undefined ? symbolRes.value.ok : contractName;

    await db
      .insert(tokenTable)
      .values({
        address: tokenAddress,
        chainId,
        symbol,
        decimals,
      })
      .onConflictDoNothing();

    logger.info({ msg: "Discovered token", token: tokenAddress, symbol, decimals });
  }
}

export interface SyncPoolTokensParams {
  client: IndexingClient;
  db: AppDatabase;
  logger: Logger;
  chainId: bigint;
  poolContract: string;
  poolToken: string;
}

export async function syncPoolTokens({
  client,
  db,
  logger,
  chainId,
  poolContract,
  poolToken,
}: SyncPoolTokensParams): Promise<void> {
  const [contractAddress, contractName] = poolContract.split(".");
  const countResult = await client.callReadOnly({
    abi: fixedWeightPoolAbi,
    contractAddress,
    contractName,
    functionName: "get-pool-count",
  });
  if (!countResult.isOk() || countResult.value.ok === undefined) {
    throw new Error(
      `Failed to fetch pool count from ${poolContract}: ${
        countResult.isErr() ? countResult.error.message : "contract call returned error"
      }`,
    );
  }

  const poolId = countResult.value.ok;

  const contractsResult = await client.callReadOnly({
    abi: fixedWeightPoolAbi,
    contractAddress,
    contractName,
    functionName: "get-pool-contracts",
    functionArgs: [poolId],
  });
  if (!contractsResult.isOk() || contractsResult.value.ok === undefined) {
    throw new Error(
      `Failed to fetch pool contracts for pool ${poolToken} (poolId: ${poolId}): ${
        contractsResult.isErr() ? contractsResult.error.message : "contract call returned error"
      }`,
    );
  }

  const tokenX = contractsResult.value.ok["token-x"];
  const tokenY = contractsResult.value.ok["token-y"];

  await discoverTokens({
    client,
    db,
    logger,
    chainId,
    tokenAddresses: [tokenX, tokenY],
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
  db: AppDatabase;
  logger: Logger;
  chainId?: bigint;
  poolContract?: string;
}

export function createPoolHandler({
  db,
  logger,
  chainId = CHAIN_ID,
  poolContract = POOL_CONTRACT,
}: CreatePoolHandlerOptions): EventHandler {
  return async (event, { client }) => {
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

      await syncPoolTokens({ client, db, logger, chainId, poolContract, poolToken: log.poolToken });
    } else if (log.action === "swap-x-for-y" || log.action === "swap-y-for-x") {
      const [pool] = await db
        .select()
        .from(poolTable)
        .where(eq(poolTable.address, log.poolToken))
        .limit(1);

      let amountIn = 0n;
      let amountOut = 0n;

      // oxlint-disable-next-line typescript/no-unnecessary-condition
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

      await upsertPoolBalances({
        db,
        poolToken: log.poolToken,
        chainId,
        balanceX: log.balanceX,
        balanceY: log.balanceY,
        totalSupply: log.totalSupply,
        blockTime: event.block_time,
      });

      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (pool && (!pool.tokenX || !pool.tokenY)) {
        await syncPoolTokens({
          client,
          db,
          logger,
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
