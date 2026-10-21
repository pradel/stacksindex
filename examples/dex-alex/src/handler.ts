import { eq } from "drizzle-orm";
import type { IndexerDb, IndexingClient, Logger } from "stacksindex";

import { fixedWeightPoolAbi, sip010Abi } from "./abi.ts";
import { indexer } from "./indexer.ts";
import { poolTable, type relations, swapTable, type Token, tokenTable } from "./schema.ts";

/** The handler's `db`: the batch transaction, typed with `relations`. */
type AppDatabase = IndexerDb<typeof relations>;

/** Rows are keyed by address and chain. */
const CHAIN_ID = 1n;

interface HandlerServices {
  client: IndexingClient;
  logger: Logger;
  db: AppDatabase;
}

async function insertTokenIfNotExists(
  { client, logger, db }: HandlerServices,
  tokenAddress: string,
): Promise<Token> {
  const existing = await db.query.token.findFirst({ where: { address: tokenAddress } });

  if (existing) {
    return existing;
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
    chainId: CHAIN_ID,
    symbol,
    decimals,
  };

  await db.insert(tokenTable).values(token).onConflictDoNothing();

  logger.info("Discovered token", { token: tokenAddress, symbol, decimals });

  return token;
}

async function syncPoolTokens(
  services: HandlerServices,
  poolContract: string,
  poolToken: string,
): Promise<void> {
  const { client, db } = services;

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

  await insertTokenIfNotExists(services, tokenX);
  await insertTokenIfNotExists(services, tokenY);

  await db.update(poolTable).set({ tokenX, tokenY }).where(eq(poolTable.address, poolToken));
}

interface PoolBalances {
  poolToken: string;
  balanceX: bigint;
  balanceY: bigint;
  totalSupply: bigint;
}

async function upsertPoolBalances(
  db: AppDatabase,
  { poolToken, balanceX, balanceY, totalSupply }: PoolBalances,
  blockTime: number,
): Promise<void> {
  await db
    .insert(poolTable)
    .values({
      address: poolToken,
      chainId: CHAIN_ID,
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
      set: { balanceX, balanceY, totalSupply },
    });
}

/**
 * Writes go through `db`, so they commit atomically with the indexer
 * checkpoint. A rewind (chain reorg, or a restart without a sync anchor)
 * re-runs handlers for unfinalized blocks without undoing their writes, so
 * every write is an upsert or insert-if-absent keyed by primary key.
 */
export const poolHandler = indexer.handler("pool", async (event, { db, client, logger }) => {
  const services = { db, client, logger };
  const log = event.data;

  if (log.action === "created") {
    await db
      .insert(poolTable)
      .values({
        address: log.poolToken,
        chainId: CHAIN_ID,
        balanceX: 0n,
        balanceY: 0n,
        totalSupply: 0n,
        feeRateX: log.feeRateX,
        feeRateY: log.feeRateY,
        feeToAddress: log.feeToAddress,
        oracleEnabled: log.oracleEnabled,
        createdAt: BigInt(event.block.time),
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

    await syncPoolTokens(services, event.contractId, log.poolToken);

    logger.debug("Pool created", { pool: log.poolToken });

    return;
  }

  if (log.action !== "swap-x-for-y" && log.action !== "swap-y-for-x") {
    // Liquidity added / removed or other pool balance changes
    await upsertPoolBalances(db, log, event.block.time);

    return;
  }

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
      txId: event.txId,
      chainId: CHAIN_ID,
      eventIndex: event.eventIndex,
      poolAddress: log.poolToken,
      action: log.action,
      amountIn,
      amountOut,
      blockHeight: BigInt(event.block.height),
      blockTime: BigInt(event.block.time),
    })
    .onConflictDoNothing();

  logger.debug("Swap created", {
    pool: log.poolToken,
    action: log.action,
    amountIn,
    amountOut,
    txId: event.txId,
  });

  await upsertPoolBalances(db, log, event.block.time);

  if (pool && (!pool.tokenX || !pool.tokenY)) {
    await syncPoolTokens(services, event.contractId, log.poolToken);
  }
});
