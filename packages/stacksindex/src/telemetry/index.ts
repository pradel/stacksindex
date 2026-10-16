import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { OtlpMetrics, OtlpSerialization } from "effect/observability";

import { ConfigurationError } from "../lib/errors.ts";

/** Default milliseconds between OTLP metric exports. */
export const DEFAULT_EXPORT_INTERVAL = 10_000;

/** Default OTel `service.name`. */
export const DEFAULT_SERVICE_NAME = "stacksindex";

export interface OtlpOptions {
  /**
   * OTLP/HTTP base URL; `/v1/metrics` is appended. e.g.
   * `http://localhost:4318` or `http://prometheus:9090/api/v1/otlp`.
   */
  baseUrl: string;
  headers?: Record<string, string>;
  /** Milliseconds between exports. Defaults to `10000`. */
  exportInterval?: number;
  /** Defaults to `"cumulative"` (Prometheus); `"delta"` for Datadog/Dynatrace. */
  temporality?: "cumulative" | "delta";
  /** OTel resource; `serviceName` defaults to `"stacksindex"`. */
  resource?: {
    serviceName?: string;
    serviceVersion?: string;
    attributes?: Record<string, string>;
  };
}

export interface TelemetryOptions {
  /** Pushes metrics over OTLP/HTTP (protobuf). Metrics are not exported when unset. */
  otlp?: OtlpOptions;
}

const StringRecord = Schema.Record(Schema.String, Schema.String);

const TelemetryOptionsSchema = Schema.Struct({
  otlp: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.NonEmptyString,
      headers: Schema.optional(StringRecord),
      exportInterval: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
      temporality: Schema.optional(Schema.Literals(["cumulative", "delta"])),
      resource: Schema.optional(
        Schema.Struct({
          serviceName: Schema.optional(Schema.NonEmptyString),
          serviceVersion: Schema.optional(Schema.String),
          attributes: Schema.optional(StringRecord),
        }),
      ),
    }),
  ),
});

/**
 * Starts the OTLP metrics exporter when `telemetry.otlp` is set. Closing the
 * layer's scope flushes the last snapshot. The exporter logs failed exports at
 * Debug only.
 */
export const telemetryLayer = (
  options: TelemetryOptions | undefined,
): Layer.Layer<never, ConfigurationError> =>
  Layer.unwrap(
    Schema.decodeUnknownEffect(TelemetryOptionsSchema)(options ?? {}).pipe(
      Effect.mapError(
        (error) => new ConfigurationError({ message: `telemetry: ${error.message}` }),
      ),
      Effect.map(({ otlp }) => {
        if (otlp === undefined) {
          return Layer.empty;
        }

        // Strip trailing slashes so `/v1/metrics` is not appended after `//`.
        const url = `${otlp.baseUrl.replace(/\/+$/u, "")}/v1/metrics`;
        const exportInterval = otlp.exportInterval ?? DEFAULT_EXPORT_INTERVAL;
        const temporality = otlp.temporality ?? "cumulative";
        const serviceName = otlp.resource?.serviceName ?? DEFAULT_SERVICE_NAME;

        // OtlpResource dies without a service name unless OTEL_SERVICE_NAME is set.
        const exporter = OtlpMetrics.layer({
          url,
          headers: otlp.headers,
          exportInterval,
          temporality,
          resource: {
            serviceName,
            serviceVersion: otlp.resource?.serviceVersion,
            attributes: otlp.resource?.attributes,
          },
        }).pipe(
          Layer.provide(Layer.mergeAll(OtlpSerialization.layerProtobuf, FetchHttpClient.layer)),
        );

        return Layer.effectDiscard(
          Effect.logInfo("Exporting metrics over OTLP").pipe(
            Effect.annotateLogs({ url, exportInterval, temporality, serviceName }),
          ),
        ).pipe(Layer.provide(exporter));
      }),
    ),
  );
