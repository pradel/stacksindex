// oxlint-disable typescript/no-confusing-void-expression
import { inspect } from "node:util";

import { createConsola, type LogLevel } from "consola/basic";
import { colors } from "consola/utils";

import { formatEta } from "../lib/timer.ts";

const INTERNAL_KEYS = ["level", "date", "msg", "duration", "error"];

export type LogValue =
  | string
  | number
  | boolean
  | bigint
  | null
  | undefined
  | LogValue[]
  | { [key: string]: LogValue };

export interface LogError extends Error {
  where?: string;
  meta?: string;
}

export interface Log {
  msg: string;
  duration?: number;
  error?: LogError;
  [key: string]: LogValue | LogError;
}

export type Logger = ReturnType<typeof createLogger>;

interface LevelStyle {
  label: string;
  colorLabel: string;
}

const levels: Partial<Record<LogLevel, LevelStyle>> = {
  0: { label: "ERROR", colorLabel: colors.red("ERROR") },
  1: { label: "WARN", colorLabel: colors.yellow("WARN") },
  2: { label: "INFO", colorLabel: colors.green("INFO") },
  4: { label: "DEBUG", colorLabel: colors.blue("DEBUG") },
  5: { label: "TRACE", colorLabel: colors.gray("TRACE") },
} as const;

const timeFormatter = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: false,
});

const isBigInt = (value: LogValue | LogError): value is bigint => typeof value === "bigint";

const isLog = (value: unknown): value is Log =>
  value !== null && typeof value === "object" && "msg" in value && typeof value.msg === "string";

const bigintReplacer = (_key: string, value: LogValue | LogError): LogValue | LogError | string =>
  isBigInt(value) ? value.toString() : value;

const serializeValue = (val: LogValue | LogError): string => {
  if (isBigInt(val)) {
    return val.toString();
  }

  try {
    return JSON.stringify(val, bigintReplacer);
  } catch {
    return inspect(val, { depth: 2, breakLength: Number.POSITIVE_INFINITY });
  }
};

export function createLogger({ level }: { level: LogLevel }) {
  const consola = createConsola({
    level,
    reporters: [
      {
        log: (log) => {
          const time = timeFormatter.format(log.date);
          // oxlint-disable-next-line typescript/no-non-null-assertion
          const levelObject = levels[log.level] ?? levels[2]!;
          const levelLabel = levelObject.colorLabel;
          const firstArg: unknown = log.args[0];

          if (!isLog(firstArg)) {
            // oxlint-disable-next-line no-console, no-undef
            console.log(String(firstArg));

            return;
          }

          const args = firstArg;
          let keyText = "";

          for (const key of Object.keys(args)) {
            if (INTERNAL_KEYS.includes(key)) {
              // oxlint-disable-next-line no-continue
              continue;
            }

            keyText += ` ${key}=${serializeValue(args[key])}`;
          }

          let durationText = "";

          if (args.duration) {
            durationText = ` ${colors.gray(`(${formatEta(args.duration)})`)}`;
          }

          const prettyLog = [
            `${colors.dim(time)} ${levelLabel} ${args.msg}${colors.dim(keyText)}${durationText}`,
          ];

          const { error } = args;

          if (error) {
            prettyLog.push(error.stack ?? `${error.name}: ${error.message}`);

            if (error.where !== undefined) {
              prettyLog.push(`where: ${error.where}`);
            }

            if (error.meta !== undefined) {
              prettyLog.push(error.meta);
            }
          }

          // oxlint-disable-next-line no-console, no-undef
          console.log(prettyLog.join("\n"));
        },
      },
    ],
  });

  return {
    info: (log: Log) => consola.log(log),
    warn: (log: Log) => consola.warn(log),
    error: (log: Log) => consola.error(log),
    debug: (log: Log) => consola.debug(log),
    trace: (log: Log) => consola.trace(log),
  };
}
