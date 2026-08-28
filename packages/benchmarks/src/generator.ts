import crypto from "node:crypto";

import type { paths } from "@stacks/blockchain-api-client";

export type ContractApiResponse =
  paths["/extended/v1/contract/{contract_id}"]["get"]["responses"]["200"]["content"]["application/json"];

export type PrincipalTransactionsResponse =
  paths["/extended/v3/principals/{principal}/transactions"]["get"]["responses"]["200"]["content"]["application/json"];

export type TransactionApiResponse = Extract<
  paths["/extended/v3/transactions/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"],
  { block: unknown }
>;

export type TransactionEventsResponse =
  paths["/extended/v3/transactions/{tx_id}/events"]["get"]["responses"]["200"]["content"]["application/json"];

export type ContractLogsResponse =
  paths["/extended/v2/smart-contracts/{contract_id}/logs"]["get"]["responses"]["200"]["content"]["application/json"];

export type SmartContractLogEvent = Extract<
  Extract<
    paths["/extended/v1/tx/{tx_id}"]["get"]["responses"]["200"]["content"]["application/json"],
    { block_height: number }
  >["events"][number],
  { event_type: "smart_contract_log" }
>;

export interface MockContractOptions {
  contractId: string;
  deploymentBlock: number;
  totalEvents: number;
  eventsPerPage?: number;
  eventsPerTx?: number;
  txsPerBlock?: number;
}

export interface GeneratedDataset {
  contractId: string;
  deploymentBlock: number;
  contractResponse: ContractApiResponse;
  principalTransactionsResponses: Map<string, PrincipalTransactionsResponse>;
  transactionResponses: Map<string, TransactionApiResponse>;
  transactionEventsResponses: Map<string, TransactionEventsResponse>;
  allEvents: {
    event: SmartContractLogEvent;
    blockHeight: number;
    txIndex: number;
    cursor: string;
  }[];
  getContractLogs: (cursor: string | null, limit: number) => ContractLogsResponse;
  totalEvents: number;
  totalTransactions: number;
  totalBlocks: number;
}

export const buildLogsCursor = ({
  blockHeight,
  microblockSequence,
  txIndex,
  eventIndex,
}: {
  blockHeight: number;
  microblockSequence: number;
  txIndex: number;
  eventIndex: number;
}): string => `${blockHeight}:${microblockSequence}:${txIndex}:${eventIndex}`;

export function generateMockDataset(options: MockContractOptions): GeneratedDataset {
  const {
    contractId,
    deploymentBlock,
    totalEvents,
    eventsPerPage = 100,
    eventsPerTx = 2,
    txsPerBlock = 3,
  } = options;

  const contractResponse: ContractApiResponse = {
    contract_id: contractId,
    block_height: deploymentBlock,
    tx_id: `tx-deploy-${contractId}`,
    source_code: "(define-data-var count uint u0)",
    clarity_version: 2,
    abi: null,
    canonical: true,
  };

  const transactionResponses = new Map<string, TransactionApiResponse>();
  const transactionEventsResponses = new Map<string, TransactionEventsResponse>();
  const allEvents: {
    event: SmartContractLogEvent;
    blockHeight: number;
    txIndex: number;
    cursor: string;
  }[] = [];

  let eventCounter = 0;
  let txCounter = 0;
  let currentBlock = deploymentBlock;
  let txInCurrentBlock = 0;

  const allTxList: {
    txId: string;
    blockHeight: number;
    txIndex: number;
    eventCount: number;
  }[] = [];

  while (eventCounter < totalEvents) {
    txCounter += 1;
    txInCurrentBlock += 1;
    if (txInCurrentBlock > txsPerBlock) {
      currentBlock += 1;
      txInCurrentBlock = 1;
    }

    const txId = `0x${crypto.createHash("sha256").update(`${contractId}-tx-${txCounter}`).digest("hex")}`;
    const blockHash = `0x${crypto.createHash("sha256").update(`${contractId}-block-${currentBlock}`).digest("hex")}`;
    const eventsInThisTx = Math.min(eventsPerTx, totalEvents - eventCounter);

    const txEvents: TransactionEventsResponse["results"] = [];
    for (let index = 0; index < eventsInThisTx; index += 1) {
      const eventIndex = index;
      const event: SmartContractLogEvent = {
        event_index: eventIndex,
        event_type: "smart_contract_log",
        tx_id: txId,
        contract_log: {
          contract_id: contractId,
          topic: "print",
          value: {
            hex: "0x0100000000000000000000000000000001",
            repr: `u${eventCounter + 1}`,
          },
        },
      };

      const cursor = buildLogsCursor({
        blockHeight: currentBlock,
        microblockSequence: 0,
        txIndex: txInCurrentBlock - 1,
        eventIndex,
      });

      allEvents.push({
        event,
        blockHeight: currentBlock,
        txIndex: txInCurrentBlock - 1,
        cursor,
      });

      txEvents.push({
        event_index: eventIndex,
        type: "contract_log",
        contract_log: {
          contract_id: contractId,
          topic: "print",
          value: {
            hex: "0x0100000000000000000000000000000001",
            repr: `u${eventCounter + 1}`,
          },
        },
      });

      eventCounter += 1;
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const fullTx = {
      tx_id: txId,
      event_count: eventsInThisTx,
      type: "contract_call" as const,
      status: "success" as const,
      fee_rate: "1000",
      sender: { address: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7", nonce: txCounter },
      sponsor: null,
      block: {
        hash: blockHash,
        height: currentBlock,
        time: 1700000000 + currentBlock * 600,
        tx_index: txInCurrentBlock - 1,
        index_hash: blockHash,
      },
      bitcoin_block: {
        height: currentBlock,
        time: 1700000000 + currentBlock * 600,
      },
      parent_block: {
        hash: `0xblock${(currentBlock - 1).toString(16).padStart(58, "0")}`,
        index_hash: `0xblock${(currentBlock - 1).toString(16).padStart(58, "0")}`,
      },
      canonical: true,
      contract_call: {
        contract_id: contractId,
        function_name: "test",
        function_signature: "(test)",
        function_args: [],
      },
    } as unknown as TransactionApiResponse;

    transactionResponses.set(txId, fullTx);
    transactionEventsResponses.set(txId, {
      total: txEvents.length,
      limit: 50,
      cursor: { next: null, previous: null, current: "0" },
      results: txEvents,
    });

    allTxList.push({
      txId,
      blockHeight: currentBlock,
      txIndex: txInCurrentBlock - 1,
      eventCount: eventsInThisTx,
    });
  }

  // Generate Principal Transactions responses (newest first as in Hiro API)
  const principalTransactionsResponses = new Map<string, PrincipalTransactionsResponse>();
  const initialPrincipalCursor = `${deploymentBlock}:0:0`;

  const principalResults = allTxList
    .slice(0, 50)
    .reverse()
    .map((item) => ({
      transaction: {
        tx_id: item.txId,
        event_count: item.eventCount,
        type: "contract_call" as const,
        status: "success" as const,
        fee_rate: "1000",
        sender: { address: "SP2J6ZY48GV1EZ5V2V5RB9MP66SW86PYKKNRV9EJ7", nonce: 1 },
        sponsor: null,
        block: {
          height: item.blockHeight,
          hash: `0xblock${item.blockHeight.toString(16).padStart(58, "0")}`,
          index_hash: `0xblock${item.blockHeight.toString(16).padStart(58, "0")}`,
          time: 1700000000 + item.blockHeight * 600,
          tx_index: item.txIndex,
        },
        bitcoin_block: {
          height: item.blockHeight,
          time: 1700000000 + item.blockHeight * 600,
        },
      },
    }));

  principalTransactionsResponses.set(initialPrincipalCursor, {
    total: allTxList.length,
    limit: 50,
    cursor: { next: null, previous: null, current: initialPrincipalCursor },
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    results: principalResults as unknown as PrincipalTransactionsResponse["results"],
  });

  const getContractLogs = (
    cursor: string | null,
    limit: number = eventsPerPage,
  ): ContractLogsResponse => {
    let startIndex = 0;
    if (cursor) {
      const foundIndex = allEvents.findIndex((item) => item.cursor === cursor);
      if (foundIndex !== -1) {
        startIndex = foundIndex;
      }
    }

    const pageEvents = allEvents.slice(startIndex, startIndex + limit);
    const nextCursor =
      startIndex + limit < allEvents.length ? allEvents[startIndex + limit].cursor : null;
    const prevCursor = startIndex > 0 ? allEvents[startIndex - 1].cursor : null;

    return {
      total: allEvents.length,
      limit,
      offset: startIndex,
      cursor: cursor ?? null,
      results: pageEvents.map((item) => item.event),
      next_cursor: nextCursor,
      prev_cursor: prevCursor,
    };
  };

  const totalBlocks = currentBlock - deploymentBlock + 1;

  return {
    contractId,
    deploymentBlock,
    contractResponse,
    principalTransactionsResponses,
    transactionResponses,
    transactionEventsResponses,
    allEvents,
    getContractLogs,
    totalEvents,
    totalTransactions: txCounter,
    totalBlocks,
  };
}
