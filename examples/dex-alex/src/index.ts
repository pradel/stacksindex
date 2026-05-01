import { PGlite } from "@electric-sql/pglite";
import { decodeClarityValue } from "@stacks/codec";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import {
  createHistoricalRuntime,
  createLogger,
  datasourceStacksApi,
  migrate as migrateIndexer,
} from "indexer";

import { poolTable, swapTable, tokenTable } from "./schema.ts";

const CHAIN_ID = 1n;

const POOL_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.fixed-weight-pool-v1-01";

const appClient = new PGlite("./data/app.db");
const appDb = drizzle({ client: appClient });

await migrate(appDb, { migrationsFolder: "./drizzle" });

const indexerClient = new PGlite("./data/indexer.db");
const indexerDb = drizzle({ client: indexerClient });

await migrateIndexer(indexerDb);

const logger = createLogger({
  level: 2,
});

function formatContractId(principal: { address: string; contract_name: string }): string {
  return `${principal.address}.${principal.contract_name}`;
}

function encodeUint(value: bigint): string {
  const hex = value.toString(16).padStart(32, "0");
  return `0x01${hex}`;
}

function decodeCallReadResult(hex: string) {
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
  const decoded = decodeClarityValue(hex) as {
    // oxlint-disable-next-line typescript-eslint/no-explicit-any
    type_id: number;
    data: unknown;
  };
  if (decoded.type_id === 7) {
    return decoded.data;
  }
  return decoded;
}

async function discoverTokens(
  // oxlint-disable-next-line typescript/no-explicit-any
  poolContracts: any,
): Promise<void> {
  /* eslint-disable typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-type-assertion */
  const tokenAddresses = [
    formatContractId(poolContracts["token-x"]),
    formatContractId(poolContracts["token-y"]),
  ];

  const existingCheck = await Promise.all(
    tokenAddresses.map((addr) =>
      appDb.select().from(tokenTable).where(eq(tokenTable.address, addr)).limit(1),
    ),
  );

  const missingTokens = tokenAddresses.filter((_addr, idx) => existingCheck[idx].length === 0);

  if (missingTokens.length === 0) {
    return;
  }

  const decimalsResults = await Promise.all(
    missingTokens.map((tokenAddress) =>
      datasourceStacksApi
        .getTokenDecimals({ logger }, tokenAddress)
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
      const decodedDecimals = decodeCallReadResult(decimalsResult.value.result) as {
        type_id: number;
        value: string;
      };
      const decimals = Number(decodedDecimals.value);

      insertOps.push(
        appDb
          .insert(tokenTable)
          .values({
            address: tokenAddress,
            chainId: CHAIN_ID,
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

const runtime = createHistoricalRuntime({ logger, db: indexerDb });

const result = await runtime.run([
  {
    contractId: POOL_CONTRACT,
    handler: async (event) => {
      /* eslint-disable typescript-eslint/no-unsafe-type-assertion, typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-argument */
      const decoded = decodeClarityValue(event.contract_log.value.hex) as {
        type_id: number;
        // oxlint-disable-next-line typescript/no-explicit-any
        data: Record<string, any>;
      };

      const tupleData = decoded.data;
      const action = tupleData.action?.data as string;
      const object = tupleData.object?.data as string;

      if (object !== "pool") {
        return;
      }

      const data = tupleData.data.data as Record<
        string,
        { value?: string; address?: string; contract_name?: string }
      >;
      const poolToken = formatContractId(
        data["pool-token"] as { address: string; contract_name: string },
      );
      const balanceX = BigInt(data["balance-x"].value ?? "0");
      const balanceY = BigInt(data["balance-y"].value ?? "0");
      const totalSupply = BigInt(data["total-supply"].value ?? "0");

      if (action === "created") {
        const feeRateX = BigInt(data["fee-rate-x"].value ?? "0");
        const feeRateY = BigInt(data["fee-rate-y"].value ?? "0");
        const feeToAddress = formatContractId(
          data["fee-to-address"] as { address: string; contract_name: string },
        );
        const oracleEnabled = data["oracle-enabled"].value === "true";

        await appDb
          .insert(poolTable)
          .values({
            address: poolToken,
            chainId: CHAIN_ID,
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

        try {
          const countResult = await datasourceStacksApi.callReadFunction(
            { logger },
            POOL_CONTRACT,
            "get-pool-count",
          );
          if (countResult.isOk() && countResult.value.okay) {
            const decodedCount = decodeCallReadResult(countResult.value.result) as {
              type_id: number;
              value: string;
            };
            const poolId = BigInt(decodedCount.value);

            const contractsResult = await datasourceStacksApi.callReadFunction(
              { logger },
              POOL_CONTRACT,
              "get-pool-contracts",
              { args: [encodeUint(poolId)] },
            );
            if (contractsResult.isOk() && contractsResult.value.okay) {
              const inner = decodeCallReadResult(contractsResult.value.result) as {
                type_id: number;
                // oxlint-disable-next-line typescript/no-explicit-any
                data: Record<string, any>;
              };
              const poolContracts = inner.data;
              await discoverTokens(poolContracts);

              const tokenX = formatContractId(poolContracts["token-x"]);
              const tokenY = formatContractId(poolContracts["token-y"]);
              await appDb
                .update(poolTable)
                .set({ tokenX, tokenY })
                .where(eq(poolTable.address, poolToken));
            }
          }
        } catch (err) {
          logger.warn({ msg: "Failed to discover tokens", pool: poolToken, error: err });
        }
      } else if (action === "swap-x-for-y" || action === "swap-y-for-x") {
        const [pool] = await appDb
          .select()
          .from(poolTable)
          .where(eq(poolTable.address, poolToken))
          .limit(1);

        let amountIn = 0n;
        let amountOut = 0n;

        // eslint-disable-next-line typescript-eslint/no-unnecessary-condition
        if (pool) {
          if (action === "swap-x-for-y") {
            amountIn = balanceX - pool.balanceX;
            amountOut = pool.balanceY - balanceY;
          } else {
            amountIn = balanceY - pool.balanceY;
            amountOut = pool.balanceX - balanceX;
          }
        }

        await appDb
          .insert(swapTable)
          .values({
            txId: event.tx_id,
            chainId: CHAIN_ID,
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
            chainId: CHAIN_ID,
            balanceX,
            balanceY,
            totalSupply,
            feeRateX: 0n,
            feeRateY: 0n,
            feeToAddress: "",
            oracleEnabled: false,
            createdAt: BigInt(event.block_time),
          })
          .onConflictDoUpdate({
            target: [poolTable.address, poolTable.chainId],
            set: {
              balanceX,
              balanceY,
              totalSupply,
            },
          });
      } else {
        // Liquidity-added, liquidity-removed
        await appDb
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
            createdAt: BigInt(event.block_time),
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
    },
  },
]);

if (result.isErr()) {
  logger.error({ msg: "Error running historical sync", error: result.error });
  // oxlint-disable-next-line no-undef
  process.exit(1);
}
