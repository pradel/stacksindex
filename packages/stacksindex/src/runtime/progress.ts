import { formatEta, startClock } from "../lib/timer.ts";

export interface HandlerSummary {
  contractId: string;
  topic?: string;
  count: number;
  totalDurationMs: number;
  avgDurationMs: number;
}

export interface ProgressTrackerOptions {
  startBlock: number;
  targetBlock?: number;
  sessionStartBlock?: number;
  clock?: () => number;
  throttleIntervalMs?: number;
}

export interface ProgressInfo {
  percentage?: string;
  prefix: string;
  block: string;
  totalEvents: number;
  rate?: string;
  eta?: string;
}

export interface ProgressTracker {
  recordEventsIndexed: (count: number) => void;
  recordHandlerExecution: (contractId: string, durationMs: number, topic?: string) => void;
  shouldLog: (channel?: string, currentBlock?: number, force?: boolean) => boolean;
  getProgress: (currentBlock: number) => ProgressInfo;
  getTotalEvents: () => number;
  getAverageRate: () => string | undefined;
  getHandlerSummaries: () => HandlerSummary[];
}

interface HandlerStat {
  contractId: string;
  topic?: string;
  count: number;
  totalDurationMs: number;
}

export function createProgressTracker(options: ProgressTrackerOptions): ProgressTracker {
  const { startBlock, targetBlock, sessionStartBlock } = options;
  const clock = options.clock ?? startClock();
  const throttleIntervalMs = options.throttleIntervalMs ?? 3000;

  let totalEventsIndexed = 0;
  const lastLoggedMsByChannel = new Map<string, number>();
  const handlerStats = new Map<string, HandlerStat>();

  return {
    recordEventsIndexed: (count: number) => {
      if (count > 0) {
        totalEventsIndexed += count;
      }
    },

    recordHandlerExecution: (contractId: string, durationMs: number, topic?: string) => {
      const key = topic ? `${contractId}::${topic}` : contractId;
      const existing = handlerStats.get(key);
      if (existing) {
        existing.count += 1;
        existing.totalDurationMs += durationMs;
      } else {
        handlerStats.set(key, {
          contractId,
          ...(topic === undefined ? {} : { topic }),
          count: 1,
          totalDurationMs: durationMs,
        });
      }
    },

    getHandlerSummaries: (): HandlerSummary[] =>
      Array.from(handlerStats.values())
        .map((stat) => ({
          contractId: stat.contractId,
          ...(stat.topic === undefined ? {} : { topic: stat.topic }),
          count: stat.count,
          totalDurationMs: stat.totalDurationMs,
          avgDurationMs: stat.count > 0 ? stat.totalDurationMs / stat.count : 0,
        }))
        .sort((statA, statB) => statB.count - statA.count),

    shouldLog: (channel = "default", currentBlock?: number, force = false): boolean => {
      const now = clock();
      if (force) {
        lastLoggedMsByChannel.set(channel, now);
        return true;
      }

      if (targetBlock !== undefined && currentBlock !== undefined && currentBlock >= targetBlock) {
        lastLoggedMsByChannel.set(channel, now);
        return true;
      }

      const lastLogged = lastLoggedMsByChannel.get(channel);
      if (lastLogged === undefined || now - lastLogged >= throttleIntervalMs) {
        lastLoggedMsByChannel.set(channel, now);
        return true;
      }

      return false;
    },

    getTotalEvents: () => totalEventsIndexed,

    getAverageRate: (): string | undefined => {
      const elapsedMs = clock();
      if (elapsedMs >= 100 && totalEventsIndexed > 0) {
        const eventsPerSec = Math.round((totalEventsIndexed / elapsedMs) * 1000);
        return `${eventsPerSec.toLocaleString("en-US")} ev/s`;
      }
      return undefined;
    },

    getProgress: (currentBlock: number): ProgressInfo => {
      let percentage: string | undefined = undefined;
      let prefix = "";
      let block = currentBlock.toLocaleString("en-US");
      let eta: string | undefined = undefined;
      let rate: string | undefined = undefined;

      const elapsedMs = clock();
      if (elapsedMs >= 500 && totalEventsIndexed > 0) {
        const eventsPerSec = Math.round((totalEventsIndexed / elapsedMs) * 1000);
        rate = `${eventsPerSec.toLocaleString("en-US")} ev/s`;
      }

      if (targetBlock !== undefined) {
        const blockSpan = targetBlock - startBlock;
        let percentageNumber = 100;

        if (blockSpan > 0) {
          const fraction = Math.min(1, Math.max(0, (currentBlock - startBlock) / blockSpan));
          percentageNumber = fraction * 100;
        }

        percentage = `${percentageNumber.toFixed(1)}%`;
        prefix = `[${percentage}]`;
        block = `${currentBlock.toLocaleString("en-US")}/${targetBlock.toLocaleString("en-US")}`;

        const sessionStart = sessionStartBlock ?? startBlock;
        const blocksDoneInSession = currentBlock - sessionStart;
        const remainingBlocks = Math.max(0, targetBlock - currentBlock);

        if (remainingBlocks === 0) {
          eta = "0s";
        } else if (blocksDoneInSession > 0 && elapsedMs > 0) {
          const msPerBlock = elapsedMs / blocksDoneInSession;
          const remainingMs = remainingBlocks * msPerBlock;
          eta = formatEta(remainingMs);
        }
      }

      return {
        ...(percentage === undefined ? {} : { percentage }),
        prefix,
        block,
        totalEvents: totalEventsIndexed,
        ...(rate === undefined ? {} : { rate }),
        ...(eta === undefined ? {} : { eta }),
      };
    },
  };
}
