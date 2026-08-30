import { setTimeout } from "node:timers/promises";

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

export interface RequestProfilerOptions {
  latencyMs?: number;
}

export const sleep = (ms: number): Promise<void> => setTimeout(ms);

export class RequestProfiler {
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

  public constructor(options?: RequestProfilerOptions) {
    this.latencyMs = options?.latencyMs ?? 0;
  }

  public reset(): void {
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

  private classifyRequest(url: string): void {
    this.metrics.total += 1;

    if (url.includes("/extended/v1/contract/")) {
      this.metrics.contractMetadata += 1;
    } else if (url.includes("/extended/v3/principals/")) {
      this.metrics.principalTransactions += 1;
    } else if (url.includes("/events") && url.includes("/extended/v3/transactions/")) {
      this.metrics.transactionEvents += 1;
    } else if (url.includes("/extended/v1/tx/multiple")) {
      this.metrics.transactionMultiple += 1;
    } else if (url.includes("/extended/v3/transactions/")) {
      this.metrics.transactionDetails += 1;
    } else if (url.includes("/extended/v2/smart-contracts/") && url.includes("/logs")) {
      this.metrics.contractLogs += 1;
    } else if (url.includes("/extended/v2/blocks/")) {
      this.metrics.blocks += 1;
    } else if (url.includes("/v2/contracts/call-read/")) {
      this.metrics.callRead += 1;
    }
  }

  public wrapHandler<TReqArgs extends unknown[], TRes>(
    handler: (rawUrl: string, ...args: TReqArgs) => Promise<TRes>,
  ): (rawUrl: string, ...args: TReqArgs) => Promise<TRes> {
    return async (rawUrl: string, ...args: TReqArgs): Promise<TRes> => {
      if (this.latencyMs > 0) {
        await sleep(this.latencyMs);
      }
      const url = decodeURIComponent(rawUrl);
      this.classifyRequest(url);
      return handler(rawUrl, ...args);
    };
  }
}
