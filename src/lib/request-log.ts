import type { Context, Next } from "hono";
import { trace } from "@opentelemetry/api";

// Per-request structured logger. One JSON object accumulated across the whole request
// ("span context"): middleware/handlers keep adding fields + events, and a single line
// is emitted when the request finishes. Lives on the Hono context as `c.get("log")`.

// Redact secret-ish values before they ever reach a log line.
// UNION of this logger's keys + audit.ts's keys (src/lib/audit.ts) so both layers redact
// the same secret-ish field names. Keep in sync if either side gains a new secret key.
const REDACT_KEYS = new Set([
  "password",
  "plain_password",
  "current_password",
  "new_password",
  "temp_password",
  "temporary_password",
  "password_hash",
  "token",
  "qr_token",
  "qr_token_plain",
  "session_token",
  "reset_token",
  "encrypted_temp_password",
  "file_content",
]);

// Key-name redactor: blanks values whose KEY looks secret. Never inspects string contents —
// for free-text leaks (DSNs/tokens embedded in strings) use scrubText() below.
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

// Free-text scrubber: catches secrets embedded INSIDE string values (the key-name redactor
// can't see these). Applied to error messages/stacks. Exported so errors.ts reuses the same rules.
const SCRUB_PATTERNS: RegExp[] = [
  /postgres(?:ql)?:\/\/[^\s"']+/gi, // postgres DSNs (creds in URL)
  // authorization/bearer/token, any of: ":", "=", or space sep, optional "Bearer " scheme, then the token tail
  /\b(?:authorization|bearer|token)\b\s*[:=]?\s*(?:bearer\s+)?[A-Za-z0-9._\-+/=]{6,}/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT (header.payload.sig)
  /\$argon2[a-z0-9]*\$[^\s"']+/gi, // argon2 password hashes
  /\b(?:temp(?:orary)?[_-]?)?passw(?:or)?d\b\s*[:=]?\s*\S+/gi, // password / temp-password forms
];
export function scrubText(text: string): string {
  let out = text;
  for (const re of SCRUB_PATTERNS) out = out.replace(re, "[REDACTED]");
  return out;
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

  // Wrap an operation in a span that records input/output (or just the error) + duration, then
  // RETHROWS on failure (never swallows). Reuses the events[] plumbing — same shape as span().
  // REDACTION CONTRACT FOR CALLERS: input/output only get the key-name redactor + (on errors)
  // the free-text scrubber. So callers MUST pass OBJECTS with safe keys (e.g. { email, count })
  // or use `pick` to project safe fields — NEVER raw positional arg arrays, raw user rows, or
  // bare primitive secrets (a plaintext password/session token passed as a primitive has no key
  // to match and WILL leak). PII (email/student_id/phone/instagram) is only caught if you keep it
  // out / pick around it — the redactor does not blank PII keys.
  async call<T>(
    name: string,
    input: unknown,
    fn: () => Promise<T> | T,
    pick?: (out: T) => unknown,
  ): Promise<T> {
    const startedAt = this.elapsed();
    try {
      const out = await fn();
      this.events.push({
        atMs: startedAt,
        name,
        data: redact({
          input,
          output: pick ? pick(out) : out,
          durationMs: this.elapsed() - startedAt,
        }),
      });
      return out;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.events.push({
        atMs: startedAt,
        name,
        // scrub free-text in the error message; key-name redact the input.
        data: { input: redact(input), error: scrubText(message), durationMs: this.elapsed() - startedAt },
      });
      throw e; // never swallow
    }
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
      ...traceFields(), // trace_id/span_id when an OTEL span is active; omitted otherwise
      ...this.fields,
      ...(this.events.length ? { spans: this.events } : {}),
      ...(this.err ? { error: this.err } : {}),
    };
  }
}

// Pull trace/span ids off the active OTEL span for log<->trace correlation.
// Degrades to {} when OTEL is disabled / no active span — never throws.
function traceFields(): Record<string, string> {
  try {
    const ctx = trace.getActiveSpan()?.spanContext();
    if (!ctx) return {};
    return { trace_id: ctx.traceId, span_id: ctx.spanId };
  } catch {
    return {};
  }
}

let counter = 0;
// Lightweight request id — fine for single-node dev/internal. Replace w/ header trace-id if needed.
function newReqId(): string {
  counter = (counter + 1) % 1e6;
  return `${Date.now().toString(36)}-${counter.toString(36)}`;
}

// Paths that must NOT emit a request-log line: scrape/probe endpoints whose own logs would
// feed back into the metrics/log pipeline (I2). Matched against the raw pathname.
const LOG_EXCLUDED_PATHS = new Set(["/metrics", "/health", "/ready"]);

// Middleware: create the request log, expose it on context, emit one JSON line at the end.
export function requestLogger() {
  return async (c: Context, next: Next) => {
    const pathname = new URL(c.req.url).pathname;
    // Early-return for probe/scrape paths — no log object, no emitted line (avoid feedback loop).
    if (LOG_EXCLUDED_PATHS.has(pathname)) {
      await next();
      return;
    }
    const reqId = c.req.header("x-request-id") ?? newReqId();
    const log = new RequestLog(reqId, c.req.method, pathname, performance.now());
    // WHO fields, set once: same header logic as requestMeta() in auth-middleware.ts.
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? c.req.header("x-real-ip") ?? null;
    log.set("ip", ip).set("userAgent", c.req.header("user-agent") ?? null);
    c.set("log", log);
    c.header("x-request-id", reqId); // surface to client/proxy for correlation
    try {
      await next();
    } finally {
      // Templated route (low cardinality) for the indexed `route` field; raw pathname stays in `path`.
      // routePath is only known after routing, hence set here. Fallback to a constant for unmatched.
      log.set("route", c.req.routePath ?? "unmatched");
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
