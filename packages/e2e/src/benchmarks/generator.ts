import crypto from "node:crypto";
import { URL } from "node:url";

export interface ContractApiResponse {
  contract_id: string;
  block_height: number;
  tx_id: string;
  source_code: string;
  clarity_version: number | null;
  abi: string | null;
  canonical: boolean;
}

export interface PrincipalTransactionsResponse {
  total: number;
  limit: number;
  cursor: {
    next: string | null;
    previous: string | null;
    current: string | null;
  };
  results: {
    transaction: {
      tx_id: string;
      event_count: number;
      type: "contract_call";
      status: "success";
      fee_rate: string;
      sender: { address: string; nonce: number };
      sponsor: null;
      block: {
        height: number;
        hash: string;
        index_hash: string;
        time: number;
        tx_index: number;
      };
      bitcoin_block: {
        height: number;
        time: number;
      };
    };
  }[];
}

export interface TransactionApiResponse {
  tx_id: string;
  event_count: number;
  type: string;
  status: string;
  fee_rate: string;
  sender: { address: string; nonce: number };
  sponsor: null;
  block: {
    hash: string;
    height: number;
    time: number;
    tx_index: number;
    index_hash: string;
  };
  bitcoin_block: {
    height: number;
    time: number;
  };
  parent_block: {
    hash: string;
    index_hash: string;
  };
  canonical: boolean;
  contract_call?: {
    contract_id: string;
    function_name: string;
    function_signature: string;
    function_args: unknown[];
  };
}

export interface TransactionEventsResponse {
  total: number;
  limit: number;
  cursor: {
    next: string | null;
    previous: string | null;
    current: string | null;
  };
  results: {
    event_index: number;
    type: string;
    contract_log: {
      contract_id: string;
      topic: string;
      value: {
        hex: string;
        repr: string;
      };
    };
  }[];
}

export interface SmartContractLogEvent {
  event_index: number;
  event_type: "smart_contract_log";
  tx_id: string;
  contract_log: {
    contract_id: string;
    topic: string;
    value: {
      hex: string;
      repr: string;
    };
  };
}

export interface ContractLogsResponse {
  total: number;
  limit: number;
  offset: number;
  cursor: string | null;
  results: SmartContractLogEvent[];
  next_cursor: string | null;
  prev_cursor: string | null;
}

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
  handleRequest: (
    url: string,
  ) => { statusCode: number; body: { json: () => Promise<unknown> } } | null;
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

    const fullTx: TransactionApiResponse = {
      tx_id: txId,
      event_count: eventsInThisTx,
      type: "contract_call",
      status: "success",
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
    };

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
    results: principalResults,
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

  const handleRequest = (
    url: string,
  ): { statusCode: number; body: { json: () => Promise<unknown> } } | null => {
    if (url.includes(`/extended/v1/contract/${contractId}`)) {
      return {
        statusCode: 200,
        body: { json: () => Promise.resolve(contractResponse) },
      };
    }

    if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
      const urlObj = new URL(url.startsWith("http") ? url : `https://api.hiro.so${url}`);
      const cursor = urlObj.searchParams.get("cursor") ?? `${deploymentBlock}:0:0`;
      const response = principalTransactionsResponses.get(cursor);
      if (response) {
        return {
          statusCode: 200,
          body: { json: () => Promise.resolve(response) },
        };
      }
    }

    if (url.includes(`/extended/v2/smart-contracts/${contractId}/logs`)) {
      const urlObj = new URL(url.startsWith("http") ? url : `https://api.hiro.so${url}`);
      const cursor = urlObj.searchParams.get("cursor");
      const limit = Number(urlObj.searchParams.get("limit") ?? "100");
      return {
        statusCode: 200,
        body: { json: () => Promise.resolve(getContractLogs(cursor, limit)) },
      };
    }

    for (const [txId, eventsResponse] of transactionEventsResponses.entries()) {
      if (url.includes(`/extended/v3/transactions/${txId}/events`)) {
        return {
          statusCode: 200,
          body: { json: () => Promise.resolve(eventsResponse) },
        };
      }
    }

    for (const [txId, txResponse] of transactionResponses.entries()) {
      if (url.includes(`/extended/v3/transactions/${txId}`)) {
        return {
          statusCode: 200,
          body: { json: () => Promise.resolve(txResponse) },
        };
      }
    }

    return null;
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
    handleRequest,
    totalEvents,
    totalTransactions: txCounter,
    totalBlocks,
  };
}
