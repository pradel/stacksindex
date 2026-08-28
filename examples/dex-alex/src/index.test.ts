// oxlint-disable typescript/no-unsafe-type-assertion
// Integration tests for the ALEX handler, run against an in-memory PGlite
// Database. Read-only call results are real Clarity hex built with the
// @stacks/transactions builders; print events are passed pre-decoded, exactly
// The way the runtime delivers them via `event.decoded`.

import path from "node:path";

import { PGlite } from "@electric-sql/pglite";
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migrateApp } from "drizzle-orm/pglite/migrator";
import {
  StacksApiUnexpectedError,
  contractPrincipalCV,
  createLogger,
  cvToHex,
  responseOkCV,
  stringAsciiCV,
  trueCV,
  tupleCV,
  uintCV,
  type CallReadResponse,
  type ClarityValue,
  type EventHandler,
  type HandlerContext,
  type IndexingClient,
  type StacksApiError,
} from "stacksindex";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { POOL_CONTRACT, createAlexHandler } from "./handler.ts";
import { poolTable, swapTable, tokenTable } from "./schema.ts";

const logger = createLogger({ level: 0 });

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALEX = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9";
const POOL_TOKEN = `${ALEX}.pool`;
const TOKEN_X = `${ALEX}.token-wstx`;
const TOKEN_Y = `${ALEX}.token-aeusdc`;

function makePrintEvent(input: {
  action: string;
  object?: string;
  data: Record<string, ClarityValue>;
}): Parameters<EventHandler>[0] {
  const decoded = tupleCV({
    action: stringAsciiCV(input.action),
    object: stringAsciiCV(input.object ?? "pool"),
    data: tupleCV(input.data),
  });
  return {
    event_index: 0,
    event_type: "smart_contract_log",
    tx_id: "tx-1",
    contract_log: {
      contract_id: POOL_CONTRACT,
      topic: "print",
      value: { hex: "", repr: "" },
    },
    block_height: 100,
    block_time: 1000,
    tx_index: 0,
    sender_address: "SP sender",
    decoded,
  };
}

interface MockCall {
  contractId: string;
  functionName: string;
}

/** Build a handler context whose read-only client answers from a fixed map. */
function makeClient(calls: Record<string, string>): { client: IndexingClient; seen: MockCall[] } {
  const seen: MockCall[] = [];
  return {
    seen,
    client: {
      callReadOnly: (
        contractId: string,
        functionName: string,
      ): Promise<Awaited<ReturnType<IndexingClient["callReadOnly"]>>> => {
        seen.push({ contractId, functionName });
        const callKey = `${contractId}::${functionName}`;
        if (Object.hasOwn(calls, callKey)) {
          return Promise.resolve(
            Result.ok<CallReadResponse, StacksApiError>({
              okay: true,
              result: calls[callKey],
            }),
          );
        }
        return Promise.resolve(
          Result.err<CallReadResponse, StacksApiError>(
            new StacksApiUnexpectedError({ message: "not mocked", cause: null, path: callKey }),
          ),
        );
      },
    },
  };
}

describe("alex handler", () => {
  // oxlint-disable-next-line init-declarations
  let appDb: PgliteDatabase;
  // oxlint-disable-next-line init-declarations
  let handler: EventHandler;

  beforeAll(async () => {
    appDb = drizzle({ client: new PGlite() });
    await migrateApp(appDb, {
      migrationsFolder: path.resolve(import.meta.dirname, "../drizzle"),
    });
    handler = createAlexHandler({ appDb, logger });
  });

  beforeEach(async () => {
    await appDb.delete(swapTable);
    await appDb.delete(poolTable);
    await appDb.delete(tokenTable);
  });

  test("indexes pool creation and discovers tokens with symbols", async () => {
    const { client } = makeClient({
      [`${POOL_CONTRACT}::get-pool-count`]: cvToHex(responseOkCV(uintCV(1n))),
      [`${POOL_CONTRACT}::get-pool-contracts`]: cvToHex(
        responseOkCV(
          tupleCV({
            "token-x": contractPrincipalCV(ALEX, "token-wstx"),
            "token-y": contractPrincipalCV(ALEX, "token-aeusdc"),
          }),
        ),
      ),
      [`${TOKEN_X}::get-decimals`]: cvToHex(responseOkCV(uintCV(6n))),
      [`${TOKEN_X}::get-symbol`]: cvToHex(responseOkCV(stringAsciiCV("sBTC"))),
      [`${TOKEN_Y}::get-decimals`]: cvToHex(responseOkCV(uintCV(6n))),
      [`${TOKEN_Y}::get-symbol`]: cvToHex(responseOkCV(stringAsciiCV("aeUSDC"))),
    });

    await handler(
      makePrintEvent({
        action: "created",
        data: {
          "pool-token": contractPrincipalCV(ALEX, "pool"),
          "balance-x": uintCV(0n),
          "balance-y": uintCV(0n),
          "total-supply": uintCV(0n),
          "fee-rate-x": uintCV(500n),
          "fee-rate-y": uintCV(300n),
          "fee-to-address": contractPrincipalCV(ALEX, "fee-receiver"),
          "oracle-enabled": trueCV(),
        },
      }),
      { db: appDb, client } as unknown as HandlerContext,
    );

    const pools = await appDb.select().from(poolTable);
    expect(pools).toHaveLength(1);
    expect(pools[0]).toMatchObject({
      address: POOL_TOKEN,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      feeRateX: 500n,
      feeRateY: 300n,
      oracleEnabled: true,
    });

    const tokens = await appDb.select().from(tokenTable);
    expect(tokens).toHaveLength(2);
    const byAddress = new Map(tokens.map((row) => [row.address, row]));
    expect(byAddress.get(TOKEN_X)).toMatchObject({ symbol: "sBTC", decimals: 6 });
    expect(byAddress.get(TOKEN_Y)).toMatchObject({ symbol: "aeUSDC", decimals: 6 });
  });

  test("indexes swaps using amounts from the print payload", async () => {
    await appDb.insert(poolTable).values({
      address: POOL_TOKEN,
      chainId: 1n,
      tokenX: TOKEN_X,
      tokenY: TOKEN_Y,
      balanceX: 24_856_000_000n,
      balanceY: 990_000n,
      totalSupply: 1_000_000n,
      feeRateX: 500n,
      feeRateY: 300n,
      feeToAddress: "",
      oracleEnabled: false,
      createdAt: 900n,
    });

    const { client } = makeClient({});

    await handler(
      makePrintEvent({
        action: "swap-x-for-y",
        data: {
          "pool-token": contractPrincipalCV(ALEX, "pool"),
          dx: uintCV(1_000_000n),
          dy: uintCV(39_600n),
          "balance-x": uintCV(24_857_000_000n),
          "balance-y": uintCV(950_400n),
        },
      }),
      { db: appDb, client } as unknown as HandlerContext,
    );

    const swaps = await appDb.select().from(swapTable);
    expect(swaps).toHaveLength(1);
    expect(swaps[0]).toMatchObject({
      poolAddress: POOL_TOKEN,
      action: "swap-x-for-y",
      amountIn: 1_000_000n,
      amountOut: 39_600n,
    });

    const [pool] = await appDb.select().from(poolTable).where(eq(poolTable.address, POOL_TOKEN));
    expect(pool.balanceX).toBe(24_857_000_000n);
    expect(pool.balanceY).toBe(950_400n);
  });

  test("falls back to balance deltas when swap args are absent", async () => {
    await appDb.insert(poolTable).values({
      address: POOL_TOKEN,
      chainId: 1n,
      balanceX: 10_000_000n,
      balanceY: 500_000n,
      totalSupply: 1_000_000n,
      feeRateX: 0n,
      feeRateY: 0n,
      feeToAddress: "",
      oracleEnabled: false,
      createdAt: 900n,
    });

    const { client } = makeClient({});

    await handler(
      makePrintEvent({
        action: "swap-y-for-x",
        data: {
          "pool-token": contractPrincipalCV(ALEX, "pool"),
          "balance-x": uintCV(9_800_000n),
          "balance-y": uintCV(520_000n),
        },
      }),
      { db: appDb, client } as unknown as HandlerContext,
    );

    const swaps = await appDb.select().from(swapTable);
    expect(swaps).toHaveLength(1);
    // Y in: 520000 - 500000; x out: 10000000 - 9800000
    expect(swaps[0].action).toBe("swap-y-for-x");
    expect(swaps[0].amountIn).toBe(20_000n);
    expect(swaps[0].amountOut).toBe(200_000n);
  });

  test("updates balances on liquidity events", async () => {
    await appDb.insert(poolTable).values({
      address: POOL_TOKEN,
      chainId: 1n,
      balanceX: 1_000n,
      balanceY: 1_000n,
      totalSupply: 1_000n,
      feeRateX: 500n,
      feeRateY: 500n,
      feeToAddress: "",
      oracleEnabled: false,
      createdAt: 900n,
    });

    const { client } = makeClient({});

    await handler(
      makePrintEvent({
        action: "liquidity-added",
        data: {
          "pool-token": contractPrincipalCV(ALEX, "pool"),
          "balance-x": uintCV(2_000n),
          "balance-y": uintCV(3_000n),
          "total-supply": uintCV(1_500n),
        },
      }),
      { db: appDb, client } as unknown as HandlerContext,
    );

    const [pool] = await appDb.select().from(poolTable).where(eq(poolTable.address, POOL_TOKEN));
    expect(pool.balanceX).toBe(2_000n);
    expect(pool.balanceY).toBe(3_000n);
    expect(pool.totalSupply).toBe(1_500n);
    // Fee metadata set at creation must survive.
    expect(pool.feeRateX).toBe(500n);
  });

  test("ignores non-pool print events", async () => {
    const { client } = makeClient({});
    await handler(
      makePrintEvent({
        action: "fees",
        object: "fees",
        data: {},
      }),
      { db: appDb, client } as unknown as HandlerContext,
    );
    const pools = await appDb.select().from(poolTable);
    expect(pools).toHaveLength(0);
  });
});
