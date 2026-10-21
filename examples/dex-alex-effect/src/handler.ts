import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { fixedWeightPoolAbi, sip010Abi } from "./abi.ts";
import { indexer } from "./indexer.ts";
import { poolTable, swapTable, type Token, tokenTable } from "./schema.ts";

/** Rows are keyed by address and chain. */
const CHAIN_ID = 1n;

const insertTokenIfNotExists = (tokenAddress: string) =>
  Effect.gen(function* () {
    const db = yield* indexer.Db;
    const client = yield* indexer.Client;

    const existing = yield* db.query.token.findFirst({ where: { address: tokenAddress } });

    if (existing) {
      return existing;
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
      chainId: CHAIN_ID,
      symbol,
      decimals,
    };

    yield* db.insert(tokenTable).values(token).onConflictDoNothing();

    yield* Effect.logInfo("Discovered token").pipe(
      Effect.annotateLogs({ token: tokenAddress, symbol, decimals }),
    );

    return token;
  });

const syncPoolTokens = (poolContract: string, poolToken: string) =>
  Effect.gen(function* () {
    const db = yield* indexer.Db;
    const client = yield* indexer.Client;

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

    yield* insertTokenIfNotExists(tokenX);
    yield* insertTokenIfNotExists(tokenY);

    yield* db.update(poolTable).set({ tokenX, tokenY }).where(eq(poolTable.address, poolToken));
  });

interface PoolBalances {
  "pool-token": string;
  "balance-x": bigint;
  "balance-y": bigint;
  "total-supply": bigint;
}

const upsertPoolBalances = (data: PoolBalances, blockTime: number) =>
  Effect.gen(function* () {
    const db = yield* indexer.Db;

    const balances = {
      balanceX: data["balance-x"],
      balanceY: data["balance-y"],
      totalSupply: data["total-supply"],
    };

    yield* db
      .insert(poolTable)
      .values({
        address: data["pool-token"],
        chainId: CHAIN_ID,
        ...balances,
        feeRateX: 0n,
        feeRateY: 0n,
        feeToAddress: "",
        oracleEnabled: false,
        createdAt: BigInt(blockTime),
      })
      .onConflictDoUpdate({
        target: [poolTable.address, poolTable.chainId],
        set: balances,
      });
  });

/**
 * Writes go through `indexer.Db`, the batch transaction, so they commit
 * atomically with the indexer checkpoint. A rewind (chain reorg, or a restart
 * without a sync anchor) re-runs handlers for unfinalized blocks without
 * undoing their writes, so every write is an upsert or insert-if-absent keyed
 * by primary key.
 */
export const PoolHandler = indexer.handler("pool", (event) =>
  Effect.gen(function* () {
    const db = yield* indexer.Db;
    const log = event.data;

    if (log.action === "created") {
      const { data } = log;

      const fees = {
        feeRateX: data["fee-rate-x"] ?? 0n,
        feeRateY: data["fee-rate-y"] ?? 0n,
        feeToAddress: data["fee-to-address"] ?? "",
        oracleEnabled: data["oracle-enabled"] ?? false,
      };

      yield* db
        .insert(poolTable)
        .values({
          address: data["pool-token"],
          chainId: CHAIN_ID,
          balanceX: 0n,
          balanceY: 0n,
          totalSupply: 0n,
          ...fees,
          createdAt: BigInt(event.block.time),
        })
        .onConflictDoUpdate({
          target: [poolTable.address, poolTable.chainId],
          set: fees,
        });

      yield* syncPoolTokens(event.contractId, data["pool-token"]);

      yield* Effect.logDebug("Pool created").pipe(
        Effect.annotateLogs({ pool: data["pool-token"] }),
      );

      return;
    }

    const { data } = log;

    if (log.action !== "swap-x-for-y" && log.action !== "swap-y-for-x") {
      // Liquidity added / removed or other pool balance changes
      yield* upsertPoolBalances(data, event.block.time);

      return;
    }

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
        txId: event.txId,
        chainId: CHAIN_ID,
        eventIndex: event.eventIndex,
        poolAddress: data["pool-token"],
        action: log.action,
        amountIn,
        amountOut,
        blockHeight: BigInt(event.block.height),
        blockTime: BigInt(event.block.time),
      })
      .onConflictDoNothing();

    yield* Effect.logDebug("Swap created").pipe(
      Effect.annotateLogs({
        pool: data["pool-token"],
        action: log.action,
        amountIn,
        amountOut,
        txId: event.txId,
      }),
    );

    yield* upsertPoolBalances(data, event.block.time);

    if (pool && (!pool.tokenX || !pool.tokenY)) {
      yield* syncPoolTokens(event.contractId, data["pool-token"]);
    }
  }),
);
