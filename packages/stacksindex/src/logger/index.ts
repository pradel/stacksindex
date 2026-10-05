import { Layer, Logger, References, type LogLevel } from "effect";

export interface LoggerLayerOptions {
  level?: LogLevel.LogLevel;
}

export const loggerLayer = (options?: LoggerLayerOptions): Layer.Layer<never> =>
  Layer.mergeAll(
    Logger.layer([Logger.consolePretty()]),
    Layer.succeed(References.MinimumLogLevel, options?.level ?? "Info"),
  );
