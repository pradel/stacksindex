// oxlint-disable typescript/no-confusing-void-expression
import { createConsola, type LogLevel } from "consola/basic";
import { colors } from "consola/utils";

import { formatEta } from "../lib/timer.ts";

const INTERNAL_KEYS = ["level", "date", "msg", "duration", "error"];

type Log = {
  msg: string;
  duration?: number;
  // oxlint-disable-next-line typescript/no-redundant-type-constituents
  error?: Error | unknown;
} & Record<string, unknown>;

export type Logger = ReturnType<typeof createLogger>;

const levels: {
  [key in LogLevel]?: { label: string; colorLabel: string };
} = {
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
          let keyText = "";
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          const args: Log = log.args[0] as Log;
          for (const key of Object.keys(args)) {
            if (INTERNAL_KEYS.includes(key)) {
              // oxlint-disable-next-line no-continue
              continue;
            }
            keyText += ` ${key}=${JSON.stringify(args[key])}`;
          }

          let durationText = "";
          if (args.duration) {
            durationText = ` ${colors.gray(`(${formatEta(args.duration)})`)}`;
          }
          const prettyLog = [
            `${colors.dim(time)} ${levelLabel} ${args.msg}${colors.dim(keyText)}${durationText}`,
          ];
          if (args.error) {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            const error = args.error as Error;
            if (error.stack) {
              prettyLog.push(error.stack);
            } else {
              prettyLog.push(`${error.name}: ${error.message}`);
            }

            if (typeof error === "object" && "where" in error) {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              prettyLog.push(`where: ${error.where as string}`);
            }
            if (typeof error === "object" && "meta" in error) {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              prettyLog.push(error.meta as string);
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
