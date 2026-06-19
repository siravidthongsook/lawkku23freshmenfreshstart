// Prometheus metrics for the api. Other workers depend on the EXACT metric
// names/labels exported here — do not rename without updating call sites.
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
  openMetricsContentType,
  type OpenMetricsContentType,
} from "prom-client";
import type { Context, MiddlewareHandler } from "hono";
import { env } from "../env";

// Kill-switch: when false, middleware is a no-op and /metrics returns empty 200.
export const metricsEnabled = env.METRICS_ENABLED;

// enableExemplars on the duration histogram REQUIRES an OpenMetrics registry — prom-client throws
// at Histogram construction otherwise. Bind the registry to OpenMetrics + set it before any metric.
export const register = new Registry<OpenMetricsContentType>();
register.setContentType(openMetricsContentType);

// Default Node/process metrics (event loop, heap, gc, ...) only when enabled.
if (metricsEnabled) {
  collectDefaultMetrics({ register });
}

export const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests by templated route, method, status.",
  labelNames: ["route", "method", "status"] as const,
  registers: [register],
});

export const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds by templated route, method.",
  labelNames: ["route", "method"] as const,
  // sane web buckets; enableExemplars lets exemplars ride along with traces.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  enableExemplars: true,
  registers: [register],
});

export const httpRequestsInFlight = new Gauge({
  name: "http_requests_in_flight",
  help: "Number of HTTP requests currently being served.",
  registers: [register],
});

export const registrationsTotal = new Counter({
  name: "registrations_total",
  help: "Total successful event registrations by event.",
  labelNames: ["event"] as const,
  registers: [register],
});

export const checkinsTotal = new Counter({
  name: "checkins_total",
  help: "Total successful check-ins by event.",
  labelNames: ["event"] as const,
  registers: [register],
});

export const loginFailuresTotal = new Counter({
  name: "login_failures_total",
  help: "Total failed login attempts.",
  registers: [register],
});

export const loginSuccessTotal = new Counter({
  name: "login_success_total",
  help: "Total successful logins.",
  registers: [register],
});

export const capacityRejectionsTotal = new Counter({
  name: "capacity_rejections_total",
  help: "Total registrations rejected because the event was at capacity.",
  registers: [register],
});

export const tempPwIssuedTotal = new Counter({
  name: "temp_pw_issued_total",
  help: "Total admin-issued temporary passwords.",
  registers: [register],
});

// Hono middleware factory: times request + records counters/histogram.
// Uses the TEMPLATED route (c.req.routePath) so UUIDs never explode cardinality.
export function metricsMiddleware(): MiddlewareHandler {
  // no-op middleware when disabled — zero overhead on the hot path.
  if (!metricsEnabled) {
    return async (_c, next) => {
      await next();
    };
  }
  return async (c, next) => {
    const method = c.req.method;
    httpRequestsInFlight.inc();
    const end = httpRequestDuration.startTimer();
    try {
      await next();
    } finally {
      // routePath is the matched template (e.g. /events/:id); fall back to
      // "unmatched" so we never label with raw pathnames / ids (I3).
      const route = c.req.routePath || "unmatched";
      const status = String(c.res.status);
      end({ route, method });
      httpRequestsTotal.inc({ route, method, status });
      httpRequestsInFlight.dec();
    }
  };
}

// Hono handler for the /metrics scrape endpoint.
export async function metricsHandler(c: Context) {
  // Return empty 200 when disabled so the Prometheus target stays "up" (§14).
  if (!metricsEnabled) {
    return c.body("", 200);
  }
  const body = await register.metrics();
  c.header("Content-Type", register.contentType);
  return c.body(body, 200);
}
