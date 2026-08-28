import { setTimeout } from "node:timers/promises";
import { URL } from "node:url";

import type { GeneratedDataset } from "./generator.ts";

export const sleep = (ms: number): Promise<void> => setTimeout(ms);

export interface RequestMetrics {
  contractMetadata: number;
  principalTransactions: number;
  transactionDetails: number;
  transactionMultiple: number;
  transactionEvents: number;
  contractLogs: number;
  blocks: number;
  callRead: number;
  total: number;
}

export interface BenchmarkResult {
  name: string;
  totalEvents: number;
  totalTransactions: number;
  totalBlocks: number;
  durationMs: number;
  throughputEventsPerSec: number;
  throughputTxsPerSec: number;
  requestMetrics: RequestMetrics;
  requestsPer100Events: number;
}

export interface BenchmarkHarnessOptions {
  datasets: GeneratedDataset[];
  latencyMs?: number;
}

interface MockResponse {
  statusCode: number;
  body: { json: () => Promise<unknown> };
}

export class BenchmarkHarness {
  private readonly datasets = new Map<string, GeneratedDataset>();
  private readonly latencyMs: number;
  public metrics: RequestMetrics = {
    contractMetadata: 0,
    principalTransactions: 0,
    transactionDetails: 0,
    transactionMultiple: 0,
    transactionEvents: 0,
    contractLogs: 0,
    blocks: 0,
    callRead: 0,
    total: 0,
  };

  public constructor(options: BenchmarkHarnessOptions) {
    for (const dataset of options.datasets) {
      this.datasets.set(dataset.contractId, dataset);
    }
    this.latencyMs = options.latencyMs ?? 0;
  }

  public resetMetrics(): void {
    this.metrics = {
      contractMetadata: 0,
      principalTransactions: 0,
      transactionDetails: 0,
      transactionMultiple: 0,
      transactionEvents: 0,
      contractLogs: 0,
      blocks: 0,
      callRead: 0,
      total: 0,
    };
  }

  private handleContractMetadata(url: string): MockResponse | null {
    if (!url.includes("/extended/v1/contract/")) {
      return null;
    }
    this.metrics.contractMetadata += 1;
    for (const [contractId, dataset] of this.datasets.entries()) {
      if (url.includes(`/extended/v1/contract/${contractId}`)) {
        return {
          statusCode: 200,
          body: { json: () => Promise.resolve(dataset.contractResponse) },
        };
      }
    }
    return null;
  }

  private handlePrincipalTransactions(url: string): MockResponse | null {
    if (!url.includes("/extended/v3/principals/")) {
      return null;
    }
    this.metrics.principalTransactions += 1;
    for (const [contractId, dataset] of this.datasets.entries()) {
      if (url.includes(`/extended/v3/principals/${contractId}/transactions`)) {
        const urlObj = new URL(url.startsWith("http") ? url : `https://api.hiro.so${url}`);
        const cursor = urlObj.searchParams.get("cursor") ?? `${dataset.deploymentBlock}:0:0`;
        const response = dataset.principalTransactionsResponses.get(cursor);
        if (response) {
          return {
            statusCode: 200,
            body: { json: () => Promise.resolve(response) },
          };
        }
      }
    }
    return null;
  }

  private handleTransactionEvents(url: string): MockResponse | null {
    if (!url.includes("/events") || !url.includes("/extended/v3/transactions/")) {
      return null;
    }
    this.metrics.transactionEvents += 1;
    for (const dataset of this.datasets.values()) {
      for (const [txId, eventsResponse] of dataset.transactionEventsResponses.entries()) {
        if (url.includes(`/extended/v3/transactions/${txId}/events`)) {
          return {
            statusCode: 200,
            body: { json: () => Promise.resolve(eventsResponse) },
          };
        }
      }
    }
    return null;
  }

  private handleTransactionMultiple(url: string): MockResponse | null {
    if (!url.includes("/extended/v1/tx/multiple")) {
      return null;
    }
    this.metrics.transactionMultiple += 1;
    const urlObj = new URL(url.startsWith("http") ? url : `https://api.hiro.so${url}`);
    const txIds = urlObj.searchParams.getAll("tx_id");
    const results: Record<string, unknown> = {};

    for (const txId of txIds) {
      for (const dataset of this.datasets.values()) {
        const tx = dataset.transactionResponses.get(txId);
        if (tx) {
          results[txId] = {
            found: true,
            result: {
              tx_id: tx.tx_id,
              nonce: tx.sender.nonce,
              fee_rate: tx.fee_rate,
              sender_address: tx.sender.address,
              sponsored: false,
              post_condition_mode: "allow",
              post_conditions: [],
              anchor_mode: "on_chain_only",
              block_hash: tx.block.hash,
              block_height: tx.block.height,
              block_time: tx.block.time,
              block_time_iso: new Date(tx.block.time * 1000).toISOString(),
              burn_block_time: tx.bitcoin_block.time,
              burn_block_height: tx.bitcoin_block.height,
              burn_block_time_iso: new Date(tx.bitcoin_block.time * 1000).toISOString(),
              parent_burn_block_time: tx.bitcoin_block.time - 600,
              parent_burn_block_time_iso: new Date(
                (tx.bitcoin_block.time - 600) * 1000,
              ).toISOString(),
              canonical: true,
              tx_index: tx.block.tx_index,
              tx_status: "success",
              tx_type: tx.type,
            },
          };
        }
      }
    }
    return {
      statusCode: 200,
      body: { json: () => Promise.resolve(results) },
    };
  }

  private handleSingleTransaction(url: string): MockResponse | null {
    if (!url.includes("/extended/v3/transactions/")) {
      return null;
    }
    this.metrics.transactionDetails += 1;
    for (const dataset of this.datasets.values()) {
      for (const [txId, txResponse] of dataset.transactionResponses.entries()) {
        if (url.includes(`/extended/v3/transactions/${txId}`)) {
          return {
            statusCode: 200,
            body: { json: () => Promise.resolve(txResponse) },
          };
        }
      }
    }
    return null;
  }

  private handleContractLogs(url: string): MockResponse | null {
    if (!url.includes("/extended/v2/smart-contracts/") || !url.includes("/logs")) {
      return null;
    }
    this.metrics.contractLogs += 1;
    for (const [contractId, dataset] of this.datasets.entries()) {
      if (url.includes(`/extended/v2/smart-contracts/${contractId}/logs`)) {
        const urlObj = new URL(url.startsWith("http") ? url : `https://api.hiro.so${url}`);
        const cursor = urlObj.searchParams.get("cursor");
        const limit = Number(urlObj.searchParams.get("limit") ?? "100");
        return {
          statusCode: 200,
          body: { json: () => Promise.resolve(dataset.getContractLogs(cursor, limit)) },
        };
      }
    }
    return null;
  }

  private handleBlocks(url: string): MockResponse | null {
    if (!url.includes("/extended/v2/blocks/")) {
      return null;
    }
    this.metrics.blocks += 1;
    return {
      statusCode: 200,
      body: {
        json: () =>
          Promise.resolve({
            canonical: true,
            height: 100,
            hash: "0xblock",
            burn_block_time: 1700000000,
            burn_block_height: 100,
          }),
      },
    };
  }

  public createMockRequestHandler() {
    return async (rawUrl: string) => {
      if (this.latencyMs > 0) {
        await sleep(this.latencyMs);
      }

      this.metrics.total += 1;
      const url = decodeURIComponent(rawUrl);

      const contractMeta = this.handleContractMetadata(url);
      if (contractMeta) {
        return contractMeta;
      }

      const principalTxs = this.handlePrincipalTransactions(url);
      if (principalTxs) {
        return principalTxs;
      }

      const txEvents = this.handleTransactionEvents(url);
      if (txEvents) {
        return txEvents;
      }

      const txMultiple = this.handleTransactionMultiple(url);
      if (txMultiple) {
        return txMultiple;
      }

      const singleTx = this.handleSingleTransaction(url);
      if (singleTx) {
        return singleTx;
      }

      const logs = this.handleContractLogs(url);
      if (logs) {
        return logs;
      }

      const blocks = this.handleBlocks(url);
      if (blocks) {
        return blocks;
      }

      throw new Error(`Unhandled mock URL in BenchmarkHarness: ${url}`);
    };
  }

  public recordResult(name: string, totalEvents: number, durationMs: number): BenchmarkResult {
    let totalTransactions = 0;
    let totalBlocks = 0;
    for (const dataset of this.datasets.values()) {
      totalTransactions += dataset.totalTransactions;
      totalBlocks += dataset.totalBlocks;
    }

    const durationSeconds = durationMs / 1000;
    const throughputEventsPerSec = durationSeconds > 0 ? totalEvents / durationSeconds : 0;
    const throughputTxsPerSec = durationSeconds > 0 ? totalTransactions / durationSeconds : 0;
    const requestsPer100Events = totalEvents > 0 ? (this.metrics.total / totalEvents) * 100 : 0;

    return {
      name,
      totalEvents,
      totalTransactions,
      totalBlocks,
      durationMs,
      throughputEventsPerSec: Math.round(throughputEventsPerSec * 10) / 10,
      throughputTxsPerSec: Math.round(throughputTxsPerSec * 10) / 10,
      requestMetrics: { ...this.metrics },
      requestsPer100Events: Math.round(requestsPer100Events * 10) / 10,
    };
  }
}
