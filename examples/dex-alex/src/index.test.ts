import { Buffer } from "node:buffer";

import { PGlite } from "@electric-sql/pglite";
// oxlint-disable typescript/no-unsafe-type-assertion
// oxlint-disable typescript/no-unsafe-return
// oxlint-disable typescript/no-explicit-any
// Integration tests for the ALEX handler, run against an in-memory PGlite
// Database. Read-only call results are real Clarity hex (verified against the
// @stacks/codec decoder); print events are passed pre-decoded, exactly the way
// The runtime delivers them via `event.decoded`.
import { Result } from "better-result";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate as migrateApp } from "drizzle-orm/pglite/migrator";
import {
  StacksApiUnexpectedError,
  createLogger,
  decodeStacksAddress,
  type ClarityValue,
  type EventHandler,
  type HandlerContext,
  type IndexingClient,
} from "stacksindex";
import { beforeAll, beforeEach, describe, expect, test } from "vite-plus/test";

import { POOL_CONTRACT, createAlexHandler } from "./handler.ts";
import { poolTable, swapTable, tokenTable } from "./schema.ts";

const logger = createLogger({ level: 0 });

// ---------------------------------------------------------------------------
// Clarity hex builders (verified against decodeClarityValue round-trips)
// ---------------------------------------------------------------------------

const hexByte = (value: number) => value.toString(16).padStart(2, "0");
const hex32 = (value: number) => value.toString(16).padStart(8, "0");

function hexAscii(text: string): string {
  return `0d${hex32(Buffer.byteLength(text))}${Buffer.from(text, "utf8").toString("hex")}`;
}

function hexUint(value: bigint): string {
  return `01${value.toString(16).padStart(32, "0")}`;
}

function hexTuple(entries: [string, string][]): string {
  const sorted = [...entries].sort((left, right) => (left[0] < right[0] ? -1 : 1));
  let body = "";
  for (const [key, value] of sorted) {
    body += `${hexByte(key.length)}${Buffer.from(key, "utf8").toString("hex")}${value}`;
  }
  return `0c${hex32(sorted.length)}${body}`;
}

const okHex = (inner: string) => `07${inner}`;

function hexPrincipal(principal: string): string {
  // Split "address.contract-name" and decode into version + hash160 bytes.
  const dot = principal.indexOf(".");
  const address = dot === -1 ? principal : principal.slice(0, dot);
  const contractName = dot === -1 ? undefined : principal.slice(dot + 1);
  const [version, hash] = decodeStacksAddress(address) as [number, string];
  const hashHex = hash.startsWith("0x") ? hash.slice(2) : hash;
  if (contractName !== undefined) {
    return `06${hexByte(version)}${hashHex}${hexByte(contractName.length)}${Buffer.from(contractName).toString("hex")}`;
  }
  return `05${hexByte(version)}${hashHex}`;
}

// ---------------------------------------------------------------------------
// Decoded-value builders (plain objects shaped like @stacks/codec results)
// ---------------------------------------------------------------------------

function cvUint(value: bigint): ClarityValue {
  return {
    type_id: 1,
    value: value.toString(),
    repr: `u${value}`,
    hex: `0x${hexUint(value)}`,
  } as unknown as ClarityValue;
}

function cvAscii(text: string): ClarityValue {
  return {
    type_id: 13,
    data: text,
    repr: `"${text}"`,
    hex: "",
  } as unknown as ClarityValue;
}

function cvPrincipalContract(principal: string): ClarityValue {
  const dot = principal.indexOf(".");
  const address = dot === -1 ? principal : principal.slice(0, dot);
  const contractName = dot === -1 ? undefined : principal.slice(dot + 1);
  const [version, hash] = decodeStacksAddress(address) as [number, string];
  if (contractName === undefined) {
    return {
      type_id: 6,
      address,
      address_version: version,
      address_hash_bytes: hash,
      repr: `'${principal}`,
      hex: "",
    } as unknown as ClarityValue;
  }
  return {
    type_id: 6,
    address,
    contract_name: contractName,
    address_version: version,
    address_hash_bytes: hash,
    repr: `'${principal}`,
    hex: "",
  } as unknown as ClarityValue;
}

function cvBool(value: boolean): ClarityValue {
  return {
    type_id: value ? 3 : 4,
    value,
    repr: String(value),
    hex: "",
  } as unknown as ClarityValue;
}

function cvTuple(data: Record<string, ClarityValue>): ClarityValue {
  return {
    type_id: 12,
    data,
    repr: "(tuple ...)",
    hex: "",
  } as unknown as ClarityValue;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const POOL_TOKEN = `SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.pool`;
const TOKEN_X = "SP102V8P0F7JX67ARQ77WEA3D3CFB5XW39REDT0AM.token-wstx";
const TOKEN_Y = "SP3Y2ZSH8P7D50B0VBTSX11S7XSG24M1VB9YFQA4K.token-aeusdc";

function makePrintEvent(input: {
  action: string;
  object?: string;
  data: Record<string, ClarityValue>;
}): Parameters<EventHandler>[0] {
  const decoded = cvTuple({
    action: cvAscii(input.action),
    object: cvAscii(input.object ?? "pool"),
    data: cvTuple(input.data),
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
          return Promise.resolve(Result.ok({ okay: true, result: calls[callKey] }));
        }
        return Promise.resolve(
          Result.err(
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
    await migrateApp(appDb, { migrationsFolder: "./drizzle" });
    handler = createAlexHandler({ appDb, logger });
  });

  beforeEach(async () => {
    await appDb.delete(swapTable);
    await appDb.delete(poolTable);
    await appDb.delete(tokenTable);
  });

  test("indexes pool creation and discovers tokens with symbols", async () => {
    const { client } = makeClient({
      [`${POOL_CONTRACT}::get-pool-count`]: okHex(hexUint(1n)),
      [`${POOL_CONTRACT}::get-pool-contracts`]: okHex(
        hexTuple([
          ["token-x", hexPrincipal(TOKEN_X)],
          ["token-y", hexPrincipal(TOKEN_Y)],
        ]),
      ),
      [`${TOKEN_X}::get-decimals`]: okHex(hexUint(6n)),
      [`${TOKEN_X}::get-symbol`]: okHex(hexAscii("sBTC")),
      [`${TOKEN_Y}::get-decimals`]: okHex(hexUint(6n)),
      [`${TOKEN_Y}::get-symbol`]: okHex(hexAscii("aeUSDC")),
    });

    await handler(
      makePrintEvent({
        action: "created",
        data: {
          "pool-token": cvPrincipalContract(POOL_TOKEN),
          "balance-x": cvUint(0n),
          "balance-y": cvUint(0n),
          "total-supply": cvUint(0n),
          "fee-rate-x": cvUint(500n),
          "fee-rate-y": cvUint(300n),
          "fee-to-address": cvPrincipalContract(
            "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fee-receiver",
          ),
          "oracle-enabled": cvBool(true),
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
          "pool-token": cvPrincipalContract(POOL_TOKEN),
          dx: cvUint(1_000_000n),
          dy: cvUint(39_600n),
          "balance-x": cvUint(24_857_000_000n),
          "balance-y": cvUint(950_400n),
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
          "pool-token": cvPrincipalContract(POOL_TOKEN),
          "balance-x": cvUint(9_800_000n),
          "balance-y": cvUint(520_000n),
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
          "pool-token": cvPrincipalContract(POOL_TOKEN),
          "balance-x": cvUint(2_000n),
          "balance-y": cvUint(3_000n),
          "total-supply": cvUint(1_500n),
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
