import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgliteDatabase } from "drizzle-orm/pglite";
import {
  ClarityType,
  decodeClarityValueUnwrapped,
  type ClarityValue,
  type EventHandler,
  type HandlerEvent,
  type IndexingClient,
  type Logger,
} from "stacksindex";

import {
  encodeUint,
  extractBool,
  extractField,
  extractPrincipal,
  extractString,
  extractUint,
  principalFromValue,
} from "./clarity.ts";
import { poolTable, swapTable, tokenTable } from "./schema.ts";

type AppDatabase = NodePgDatabase | PgliteDatabase;

export const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

export interface AlexHandlerContext {
  /** Application database holding the derived tables. */
  appDb: AppDatabase;
  logger: Logger;
}

interface PrintEventData {
  action?: string;
  object?: string;
  /** Nested `(data (...))` tuple value, kept wrapped for the extract* helpers. */
  data?: ClarityValue;
}

function parsePrintEvent(event: HandlerEvent): PrintEventData | undefined {
  const tuple = event.decoded;
  if (tuple === undefined || tuple.type !== ClarityType.Tuple) {
    return undefined;
  }
  return {
    action: extractString(tuple, "action"),
    object: extractString(tuple, "object"),
    // Keep the nested tuple wrapped: downstream extract* helpers take a value.
    data: extractField(tuple, "data"),
  };
}

async function readUint(
  client: IndexingClient,
  functionName: string,
  args: string[] = [],
): Promise<bigint | undefined> {
  const result = await client.callReadOnly(POOL_CONTRACT, functionName, { args });
  if (result.isErr() || !result.value.okay) {
    return undefined;
  }
  const decoded = decodeClarityValueUnwrapped(result.value.result);
  return decoded !== undefined && decoded.type === ClarityType.UInt
    ? BigInt(decoded.value)
    : undefined;
}

async function readPoolContracts(
  client: IndexingClient,
  poolId: bigint,
): Promise<Record<string, ClarityValue> | undefined> {
  const result = await client.callReadOnly(POOL_CONTRACT, "get-pool-contracts", {
    args: [encodeUint(poolId)],
  });
  if (result.isErr() || !result.value.okay) {
    return undefined;
  }
  const decoded = decodeClarityValueUnwrapped(result.value.result);
  return decoded !== undefined && decoded.type === ClarityType.Tuple ? decoded.value : undefined;
}

async function readSymbol(
  client: IndexingClient,
  tokenAddress: string,
): Promise<string | undefined> {
  const result = await client.callReadOnly(tokenAddress, "get-symbol");
  if (result.isErr() || !result.value.okay) {
    return undefined;
  }
  const decoded = decodeClarityValueUnwrapped(result.value.result);
  return decoded !== undefined && decoded.type === ClarityType.StringASCII
    ? decoded.value
    : undefined;
}

async function readDecimals(
  client: IndexingClient,
  tokenAddress: string,
): Promise<bigint | undefined> {
  const result = await client.callReadOnly(tokenAddress, "get-decimals");
  if (result.isErr() || !result.value.okay) {
    return undefined;
  }
  const decoded = decodeClarityValueUnwrapped(result.value.result);
  return decoded !== undefined && decoded.type === ClarityType.UInt
    ? BigInt(decoded.value)
    : undefined;
}

/** Fetch a single token's metadata and store it. */
async function discoverToken(
  context: AlexHandlerContext,
  client: IndexingClient,
  address: string,
): Promise<void> {
  const { appDb, logger } = context;
  // Sequential by design: one read-only call set per new token.
  // oxlint-disable-next-line no-await-in-loop
  const decimals = await readDecimals(client, address);
  // oxlint-disable-next-line no-await-in-loop
  let symbol = await readSymbol(client, address);
  if (decimals === undefined || symbol === undefined) {
    logger.warn({ msg: "Incomplete token metadata", token: address });
  }
  symbol ??= address;
  // oxlint-disable-next-line no-await-in-loop
  await appDb
    .insert(tokenTable)
    .values({ address, chainId: 1n, symbol, decimals: Number(decimals ?? 0n) })
    .onConflictDoNothing();
  logger.info({ msg: "Discovered token", token: address, symbol });
}

async function findToken(appDb: AppDatabase, address: string): Promise<{ address: string } | null> {
  const rows = await appDb
    .select()
    .from(tokenTable)
    .where(eq(tokenTable.address, address))
    .limit(1);
  return rows.at(0) ?? null;
}

/** Resolve pool tokens via read-only calls and store any unknown ones. */
async function discoverTokens(
  appDb: AppDatabase,
  logger: Logger,
  client: IndexingClient,
): Promise<{ tokenX?: string; tokenY?: string }> {
  const poolCount = await readUint(client, "get-pool-count");
  if (poolCount === undefined) {
    logger.warn({ msg: "Failed to read pool count" });
    return {};
  }

  // Pool ids are 1-based; the most recent creation has id == count.
  const contracts = await readPoolContracts(client, poolCount);
  if (contracts === undefined) {
    logger.warn({ msg: "Failed to read pool contracts", poolId: poolCount.toString() });
    return {};
  }

  const tokenX = principalFromValue(contracts["token-x"]);
  const tokenY = principalFromValue(contracts["token-y"]);

  for (const address of [tokenX, tokenY]) {
    if (address === undefined) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    const known = await findToken(appDb, address);
    if (known !== null) {
      // oxlint-disable-next-line no-continue
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop
    await discoverToken({ appDb, logger }, client, address);
  }

  return { tokenX, tokenY };
}

async function handlePoolCreated(
  context: AlexHandlerContext & { client: IndexingClient },
  event: HandlerEvent,
  data: ClarityValue,
  poolToken: string,
): Promise<void> {
  const { appDb, logger } = context;
  const feeRateX = extractUint(data, "fee-rate-x") ?? 0n;
  const feeRateY = extractUint(data, "fee-rate-y") ?? 0n;
  const feeToAddress = extractPrincipal(data, "fee-to-address") ?? "";
  const oracleEnabled = extractBool(data, "oracle-enabled") ?? false;

  await appDb
    .insert(poolTable)
    .values({
      address: poolToken,
      chainId: 1n,
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
      set: { feeRateX, feeRateY, feeToAddress, oracleEnabled },
    });

  try {
    const { tokenX, tokenY } = await discoverTokens(appDb, logger, context.client);
    if (tokenX !== undefined || tokenY !== undefined) {
      await appDb.update(poolTable).set({ tokenX, tokenY }).where(eq(poolTable.address, poolToken));
    }
  } catch (err) {
    logger.warn({ msg: "Failed to discover tokens", pool: poolToken, error: err });
  }
}

/** Prefer amounts from the print payload; fall back to balance deltas. */
interface Balances {
  balanceX?: bigint;
  balanceY?: bigint;
}

/** Prefer amounts from the print payload; fall back to balance deltas. */
function resolveSwapAmounts(
  action: string,
  data: ClarityValue,
  stored: Balances,
  next: { balanceX: bigint; balanceY: bigint },
): { amountIn: bigint; amountOut: bigint } {
  const amountInFromArgs = extractUint(data, "dx");
  const amountOutFromArgs = extractUint(data, "dy");
  if (amountInFromArgs !== undefined && amountOutFromArgs !== undefined) {
    return { amountIn: amountInFromArgs, amountOut: amountOutFromArgs };
  }
  if (action === "swap-x-for-y") {
    return {
      amountIn: next.balanceX - (stored.balanceX ?? next.balanceX),
      amountOut: (stored.balanceY ?? next.balanceY) - next.balanceY,
    };
  }
  return {
    amountIn: next.balanceY - (stored.balanceY ?? next.balanceY),
    amountOut: (stored.balanceX ?? next.balanceX) - next.balanceX,
  };
}

async function handleSwap(
  appDb: AppDatabase,
  event: HandlerEvent,
  action: string,
  data: ClarityValue,
  poolToken: string,
  balanceX: bigint,
  balanceY: bigint,
): Promise<void> {
  const poolRows = await appDb
    .select()
    .from(poolTable)
    .where(eq(poolTable.address, poolToken))
    .limit(1);
  const pool = poolRows.at(0);

  const { amountIn, amountOut } = resolveSwapAmounts(
    action,
    data,
    { balanceX: pool?.balanceX, balanceY: pool?.balanceY },
    { balanceX, balanceY },
  );

  await appDb
    .insert(swapTable)
    .values({
      txId: event.tx_id,
      chainId: 1n,
      eventIndex: event.event_index,
      poolAddress: poolToken,
      action,
      amountIn,
      amountOut,
      blockHeight: BigInt(event.block_height),
      blockTime: BigInt(event.block_time),
    })
    .onConflictDoNothing();

  await appDb
    .insert(poolTable)
    .values({
      address: poolToken,
      chainId: 1n,
      balanceX,
      balanceY,
      totalSupply: extractUint(data, "total-supply") ?? pool?.totalSupply ?? 0n,
      feeRateX: pool?.feeRateX ?? 0n,
      feeRateY: pool?.feeRateY ?? 0n,
      feeToAddress: pool?.feeToAddress ?? "",
      oracleEnabled: pool?.oracleEnabled ?? false,
      createdAt: BigInt(event.block_time),
    })
    .onConflictDoUpdate({
      target: [poolTable.address, poolTable.chainId],
      set: { balanceX, balanceY },
    });
}

async function syncPoolState(
  appDb: AppDatabase,
  event: HandlerEvent,
  data: ClarityValue,
  poolToken: string,
  balanceX: bigint,
  balanceY: bigint,
): Promise<void> {
  const poolRows = await appDb
    .select()
    .from(poolTable)
    .where(eq(poolTable.address, poolToken))
    .limit(1);
  const pool = poolRows.at(0);
  const totalSupply = extractUint(data, "total-supply") ?? pool?.totalSupply ?? 0n;
  await appDb
    .insert(poolTable)
    .values({
      address: poolToken,
      chainId: 1n,
      balanceX,
      balanceY,
      totalSupply,
      feeRateX: pool?.feeRateX ?? 0n,
      feeRateY: pool?.feeRateY ?? 0n,
      feeToAddress: pool?.feeToAddress ?? "",
      oracleEnabled: pool?.oracleEnabled ?? false,
      createdAt: BigInt(event.block_time),
    })
    .onConflictDoUpdate({
      target: [poolTable.address, poolTable.chainId],
      set: { balanceX, balanceY, totalSupply },
    });
}

/**
 * Build the ALEX fixed-weight-pool event handler.
 * Returns an `EventHandler` suitable for `runtime.run([{ contractId, handler }])`.
 */
export function createAlexHandler(context: AlexHandlerContext): EventHandler {
  const { appDb } = context;

  return async (event, ctx) => {
    const print = parsePrintEvent(event);
    if (print?.object !== "pool") {
      return;
    }

    const { data } = print;
    if (data === undefined) {
      return;
    }
    const { action } = print;
    if (action === undefined) {
      return;
    }

    const poolToken = extractPrincipal(data, "pool-token") ?? "";
    const balanceX = extractUint(data, "balance-x") ?? 0n;
    const balanceY = extractUint(data, "balance-y") ?? 0n;

    switch (action) {
      case "created": {
        await handlePoolCreated({ ...context, client: ctx.client }, event, data, poolToken);
        break;
      }
      case "swap-x-for-y":
      case "swap-y-for-x": {
        await handleSwap(appDb, event, action, data, poolToken, balanceX, balanceY);
        break;
      }
      default: {
        // Liquidity-added / liquidity-reduced: keep balances and supply in sync.
        await syncPoolState(appDb, event, data, poolToken, balanceX, balanceY);
      }
    }
  };
}
