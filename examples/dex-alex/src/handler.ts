import { ClarityTypeID, type ClarityValue, decodeClarityValue } from "@stacks/codec";
import { eq } from "drizzle-orm";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import type { EventHandler, IndexingClient, Logger } from "indexer";

import { poolTable, swapTable, tokenTable } from "./schema.ts";

export const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";
export const CHAIN_ID = 1n;

export interface PrincipalData {
  address: string;
  contract_name: string;
}

export function formatContractId(principal: PrincipalData): string {
  return `${principal.address}.${principal.contract_name}`;
}

export function encodeUint(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  return `0x01${hex}`;
}

export function decodeCallReadResult(hex: string): ClarityValue {
  const decoded = decodeClarityValue(hex);
  if (decoded.type_id === ClarityTypeID.ResponseOk) {
    return decoded.value;
  }
  return decoded;
}

export function getTupleData(
  value: ClarityValue | undefined,
): Record<string, ClarityValue> | undefined {
  if (value !== undefined && value.type_id === ClarityTypeID.Tuple) {
    return value.data;
  }
  return undefined;
}

export function getStringData(value: ClarityValue | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value.type_id === ClarityTypeID.StringAscii || value.type_id === ClarityTypeID.StringUtf8) {
    return value.data;
  }
  return undefined;
}

export function getUintValue(value: ClarityValue | undefined): bigint {
  if (value !== undefined && value.type_id === ClarityTypeID.UInt) {
    return BigInt(value.value);
  }
  return 0n;
}

export function getPrincipalData(value: ClarityValue | undefined): PrincipalData | undefined {
  if (value !== undefined && value.type_id === ClarityTypeID.PrincipalContract) {
    return { address: value.address, contract_name: value.contract_name };
  }
  return undefined;
}

export function getBoolValue(value: ClarityValue | undefined): boolean {
  if (value === undefined) {
    return false;
  }
  if (value.type_id === ClarityTypeID.BoolTrue) {
    return true;
  }
  if (value.type_id === ClarityTypeID.BoolFalse) {
    return false;
  }
  return false;
}

export interface DiscoverTokensParams {
  client: IndexingClient;
  db: PgliteDatabase;
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

  const decimalsResults = await Promise.all(
    missingTokens.map((tokenAddress) =>
      client
        .callReadOnly(tokenAddress, "get-decimals")
        .then((res) => ({ tokenAddress, result: res })),
    ),
  );

  const insertOps = [];
  for (const { tokenAddress, result: decimalsResult } of decimalsResults) {
    if (!decimalsResult.isOk() || !decimalsResult.value.okay) {
      logger.warn({
        msg: "Failed to fetch token decimals",
        token: tokenAddress,
        error: decimalsResult.isErr() ? decimalsResult.error : "not okay",
      });
    } else {
      const decodedDecimals = decodeCallReadResult(decimalsResult.value.result);
      const decimals = Number(getUintValue(decodedDecimals));

      insertOps.push(
        db
          .insert(tokenTable)
          .values({
            address: tokenAddress,
            chainId,
            symbol: tokenAddress,
            decimals,
          })
          .onConflictDoNothing(),
      );
      logger.info({ msg: "Discovered token", token: tokenAddress, decimals });
    }
  }
  if (insertOps.length > 0) {
    await Promise.all(insertOps);
  }
}

export interface SyncPoolTokensParams {
  client: IndexingClient;
  db: PgliteDatabase;
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
  try {
    const countResult = await client.callReadOnly(poolContract, "get-pool-count");
    if (!countResult.isOk() || !countResult.value.okay) {
      return;
    }

    const decodedCount = decodeCallReadResult(countResult.value.result);
    const poolId = getUintValue(decodedCount);

    const contractsResult = await client.callReadOnly(poolContract, "get-pool-contracts", {
      args: [encodeUint(poolId)],
    });
    if (!contractsResult.isOk() || !contractsResult.value.okay) {
      return;
    }

    const decodedContracts = decodeCallReadResult(contractsResult.value.result);
    const poolContracts = getTupleData(decodedContracts);
    if (!poolContracts) {
      return;
    }

    const tokenXPrincipal = getPrincipalData(poolContracts["token-x"]);
    const tokenYPrincipal = getPrincipalData(poolContracts["token-y"]);
    if (!tokenXPrincipal || !tokenYPrincipal) {
      return;
    }

    const tokenX = formatContractId(tokenXPrincipal);
    const tokenY = formatContractId(tokenYPrincipal);

    await discoverTokens({
      client,
      db,
      logger,
      chainId,
      tokenAddresses: [tokenX, tokenY],
    });

    await db.update(poolTable).set({ tokenX, tokenY }).where(eq(poolTable.address, poolToken));
  } catch (err) {
    logger.warn({ msg: "Failed to discover tokens", pool: poolToken, error: err });
  }
}

interface UpsertPoolBalancesParams {
  db: PgliteDatabase;
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
  db: PgliteDatabase;
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
    const decoded = decodeClarityValue(event.contract_log.value.hex);
    const tupleData = getTupleData(decoded);
    if (!tupleData) {
      return;
    }

    const action = getStringData(tupleData.action);
    const object = getStringData(tupleData.object);

    if (object !== "pool") {
      return;
    }

    const data = getTupleData(tupleData.data);
    if (!data) {
      return;
    }

    const poolTokenPrincipal = getPrincipalData(data["pool-token"]);
    if (!poolTokenPrincipal) {
      return;
    }

    const poolToken = formatContractId(poolTokenPrincipal);
    const balanceX = getUintValue(data["balance-x"]);
    const balanceY = getUintValue(data["balance-y"]);
    const totalSupply = getUintValue(data["total-supply"]);

    if (action === "created") {
      const feeRateX = getUintValue(data["fee-rate-x"]);
      const feeRateY = getUintValue(data["fee-rate-y"]);
      const feeToPrincipal = getPrincipalData(data["fee-to-address"]);
      const feeToAddress = feeToPrincipal ? formatContractId(feeToPrincipal) : "";
      const oracleEnabled = getBoolValue(data["oracle-enabled"]);

      await db
        .insert(poolTable)
        .values({
          address: poolToken,
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

      await syncPoolTokens({ client, db, logger, chainId, poolContract, poolToken });
    } else if (action === "swap-x-for-y" || action === "swap-y-for-x") {
      const [pool] = await db
        .select()
        .from(poolTable)
        .where(eq(poolTable.address, poolToken))
        .limit(1);

      let amountIn = 0n;
      let amountOut = 0n;

      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (pool) {
        if (action === "swap-x-for-y") {
          amountIn = balanceX - pool.balanceX;
          amountOut = pool.balanceY - balanceY;
        } else {
          amountIn = balanceY - pool.balanceY;
          amountOut = pool.balanceX - balanceX;
        }
      }

      await db
        .insert(swapTable)
        .values({
          txId: event.tx_id,
          chainId,
          eventIndex: event.event_index,
          poolAddress: poolToken,
          action,
          amountIn,
          amountOut,
          blockHeight: BigInt(event.block_height),
          blockTime: BigInt(event.block_time),
        })
        .onConflictDoNothing();

      await upsertPoolBalances({
        db,
        poolToken,
        chainId,
        balanceX,
        balanceY,
        totalSupply,
        blockTime: event.block_time,
      });
    } else {
      // Liquidity added / removed or other pool balance changes
      await upsertPoolBalances({
        db,
        poolToken,
        chainId,
        balanceX,
        balanceY,
        totalSupply,
        blockTime: event.block_time,
      });
    }
  };
}
