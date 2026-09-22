import { eq } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";
import {
  decodeHex,
  type EventHandler,
  type IndexerDb,
  type IndexingClient,
  type Logger,
} from "stacksindex";

import { fixedWeightPoolAbi, sip010Abi } from "./abi.ts";
import { poolTable, swapTable, type Token, tokenTable } from "./schema.ts";

export type AppDatabase = IndexerDb;

export const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";
export const CHAIN_ID = 1n;

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

const OtherPoolAction = Schema.Union([
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
  logger: Logger;
  chainId: bigint;
  tokenAddress: string;
}

export async function insertTokenIfNotExists({
  client,
  db,
  logger,
  chainId,
  tokenAddress,
}: InsertTokenIfNotExistsParams): Promise<Token> {
  const existingCheck = await Effect.runPromise(
    db.select().from(tokenTable).where(eq(tokenTable.address, tokenAddress)).limit(1),
  );

  if (existingCheck.length > 0) {
    return existingCheck[0];
  }

  const [contractAddress, contractName] = tokenAddress.split(".");
  if (!contractAddress || !contractName) {
    throw new Error(`Invalid tokenAddress: ${tokenAddress}`);
  }

  const decimalsRes = await Effect.runPromise(
    client.callReadOnly({
      abi: sip010Abi,
      contractAddress,
      contractName,
      functionName: "get-decimals",
    }),
  );

  const symbolRes = await Effect.runPromise(
    client.callReadOnly({
      abi: sip010Abi,
      contractAddress,
      contractName,
      functionName: "get-symbol",
    }),
  );

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

  await Effect.runPromise(db.insert(tokenTable).values(token).onConflictDoNothing());

  logger.info({ msg: "Discovered token", token: tokenAddress, symbol, decimals });

  return token;
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
  if (!contractAddress || !contractName) {
    throw new Error(`Invalid poolContract: ${poolContract}`);
  }
  const poolId = await Effect.runPromise(
    client.callReadOnly({
      abi: fixedWeightPoolAbi,
      contractAddress,
      contractName,
      functionName: "get-pool-count",
    }),
  );

  if (poolId === 0n) {
    throw new Error(`Failed to fetch pool count from ${poolContract}: pool count is 0`);
  }

  const contractsResult = await Effect.runPromise(
    client.callReadOnly({
      abi: fixedWeightPoolAbi,
      contractAddress,
      contractName,
      functionName: "get-pool-contracts",
      functionArgs: [poolId],
    }),
  );

  if (contractsResult.ok === undefined) {
    throw new Error(
      `Failed to fetch pool contracts for pool ${poolToken} (poolId: ${poolId}): contract returned error ${contractsResult.error}`,
    );
  }

  const tokenX = contractsResult.ok["token-x"];
  const tokenY = contractsResult.ok["token-y"];

  await insertTokenIfNotExists({
    client,
    db,
    logger,
    chainId,
    tokenAddress: tokenX,
  });

  await insertTokenIfNotExists({
    client,
    db,
    logger,
    chainId,
    tokenAddress: tokenY,
  });

  await Effect.runPromise(
    db.update(poolTable).set({ tokenX, tokenY }).where(eq(poolTable.address, poolToken)),
  );
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
  await Effect.runPromise(
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
      }),
  );
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

      await Effect.runPromise(
        db
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
          }),
      );

      await syncPoolTokens({
        client,
        db,
        logger,
        chainId,
        poolContract,
        poolToken: data["pool-token"],
      });

      logger.debug({ msg: "Pool created", pool: data["pool-token"] });
    } else if (log.action === "swap-x-for-y" || log.action === "swap-y-for-x") {
      const { data } = log;
      const [pool] = await Effect.runPromise(
        db.select().from(poolTable).where(eq(poolTable.address, data["pool-token"])).limit(1),
      );

      let amountIn = 0n;
      let amountOut = 0n;

      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (pool) {
        if (log.action === "swap-x-for-y") {
          amountIn = data["balance-x"] - pool.balanceX;
          amountOut = pool.balanceY - data["balance-y"];
        } else {
          amountIn = data["balance-y"] - pool.balanceY;
          amountOut = pool.balanceX - data["balance-x"];
        }
      }

      await Effect.runPromise(
        db
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
          .onConflictDoNothing(),
      );

      logger.debug({
        msg: "Swap created",
        pool: data["pool-token"],
        action: log.action,
        amountIn,
        amountOut,
        txId: event.tx_id,
      });

      await upsertPoolBalances({
        db,
        poolToken: data["pool-token"],
        chainId,
        balanceX: data["balance-x"],
        balanceY: data["balance-y"],
        totalSupply: data["total-supply"],
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
          poolToken: data["pool-token"],
        });
      }
    } else {
      // Liquidity added / removed or other pool balance changes
      const { data } = log;
      await upsertPoolBalances({
        db,
        poolToken: data["pool-token"],
        chainId,
        balanceX: data["balance-x"],
        balanceY: data["balance-y"],
        totalSupply: data["total-supply"],
        blockTime: event.block_time,
      });
    }
  };
}
