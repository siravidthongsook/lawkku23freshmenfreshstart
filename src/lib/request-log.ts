import type { Context, Next } from "hono";

// Per-request structured logger. One JSON object accumulated across the whole request
// ("span context"): middleware/handlers keep adding fields + events, and a single line
// is emitted when the request finishes. Lives on the Hono context as `c.get("log")`.

// Redact secret-ish values before they ever reach a log line.
const REDACT_KEYS = new Set([
  "password",
  "current_password",
  "new_password",
  "temp_password",
  "temporary_password",
  "password_hash",
  "token",
  "qr_token",
  "session_token",
  "reset_token",
  "encrypted_temp_password",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

type LogEvent = { atMs: number; name: string; data?: unknown };

export class RequestLog {
  readonly reqId: string;
  readonly method: string;
  readonly path: string;
  private readonly startMs: number;
  private status = 0;
  private fields: Record<string, unknown> = {};
  private events: LogEvent[] = [];
  private err: Record<string, unknown> | null = null;

  constructor(reqId: string, method: string, path: string, startMs: number) {
    this.reqId = reqId;
    this.method = method;
    this.path = path;
    this.startMs = startMs;
  }

  private elapsed(): number {
    return Math.round(performance.now() - this.startMs);
  }

  // Set a top-level field (last write wins) — e.g. userId, role, eventId. Redacted.
  set(key: string, value: unknown): this {
    this.fields[key] = redact(value);
    return this;
  }

  // Record a point-in-time event with optional data. Redacted.
  event(name: string, data?: unknown): this {
    this.events.push({ atMs: this.elapsed(), name, data: data === undefined ? undefined : redact(data) });
    return this;
  }

  // Open a span; call the returned fn to close it with a measured duration (+ optional extra data).
  span(name: string, data?: unknown): (extra?: unknown) => void {
    const startedAt = this.elapsed();
    return (extra?: unknown) => {
      this.events.push({
        atMs: startedAt,
        name,
        data: redact({ durationMs: this.elapsed() - startedAt, ...(data as object), ...(extra as object) }),
      });
    };
  }

  // Attach the request error (set by the central error handler). Redacted.
  setError(code: string, message: string, details?: unknown): this {
    this.err = { code, message, details: details === undefined ? undefined : redact(details) };
    return this;
  }

  setStatus(status: number): this {
    this.status = status;
    return this;
  }

  hasError(): boolean {
    return this.err !== null;
  }

  toJSON(): Record<string, unknown> {
    const level = this.status >= 500 || (this.err && this.status === 0) ? "error" : this.status >= 400 ? "warn" : "info";
    return {
      ts: new Date().toISOString(),
      level,
      reqId: this.reqId,
      method: this.method,
      path: this.path,
      status: this.status,
      durationMs: this.elapsed(),
      ...this.fields,
      ...(this.events.length ? { spans: this.events } : {}),
      ...(this.err ? { error: this.err } : {}),
    };
  }
}

let counter = 0;
// Lightweight request id — fine for single-node dev/internal. Replace w/ header trace-id if needed.
function newReqId(): string {
  counter = (counter + 1) % 1e6;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

// Middleware: create the request log, expose it on context, emit one JSON line at the end.
export function requestLogger() {
  return async (c: Context, next: Next) => {
    const reqId = c.req.header("x-request-id") ?? newReqId();
    const log = new RequestLog(reqId, c.req.method, new URL(c.req.url).pathname, performance.now());
    c.set("log", log);
    c.header("x-request-id", reqId); // surface to client/proxy for correlation
    try {
      await next();
    } finally {
      // c.res.status holds the final status whether set by handler or onError.
      const status = c.res?.status ?? 0;
      log.setStatus(status);
      // Capture the error body on any 4xx/5xx if not already recorded. This also catches
      // @hono/zod-validator's OWN 400 (which bypasses onError) — that's where the login
      // 400 "why" lives. Clone so the client still gets the untouched response.
      if (status >= 400 && !log.hasError()) {
        try {
          const body = (await c.res.clone().json()) as { error?: string; message?: string; details?: unknown; [k: string]: unknown };
          log.setError(body.error ?? "error", body.message ?? "", body.details ?? body);
        } catch {
          // non-JSON error body — leave error unset
        }
      }
      const line = log.toJSON();
      const sink = line.level === "error" ? console.error : line.level === "warn" ? console.warn : console.log;
      sink(JSON.stringify(line));
    }
  };
}
