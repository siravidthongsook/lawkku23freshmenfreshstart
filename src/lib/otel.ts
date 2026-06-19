// OpenTelemetry bootstrap. PRELOADED via `tsx --import ./src/lib/otel.ts` so
// instrumentation patches http/pg before the app graph loads. Read process.env
// directly here — the zod env module may not be safe to import this early.
import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

// Kill-switch: default ON, "false" skips SDK registration entirely (§14).
const otelEnabled = (process.env.OTEL_ENABLED ?? "true") !== "false";

if (otelEnabled) {
  // Surface SDK/exporter problems as warnings only — never crash the process.
  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR);

  const endpoint =
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://tempo:4318";

  const sdk = new NodeSDK({
    serviceName: "eticket-api",
    // OTLP HTTP path is /v1/traces under the base endpoint.
    traceExporter: new OTLPTraceExporter({
      url: `${endpoint.replace(/\/$/, "")}/v1/traces`,
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  // Must be non-fatal if Tempo is unreachable — boot has to succeed (§10d).
  try {
    sdk.start();
    console.log(`otel: tracing enabled, exporting to ${endpoint}`);
  } catch (err) {
    console.warn("otel: failed to start, continuing without tracing", err);
  }

  // Flush spans on shutdown; swallow errors so shutdown is never blocked.
  const shutdown = () => {
    sdk
      .shutdown()
      .catch((err: unknown) => console.warn("otel: shutdown error", err));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
