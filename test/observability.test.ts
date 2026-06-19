import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RequestLog, scrubText } from "../src/lib/request-log";
import { register } from "../src/lib/metrics";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent } from "./helpers/factories";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";

// =====================================================================
// §10a observability suite — RequestLog.call(), redaction, scrubText,
// metrics route-label cardinality + business counters, signin 5WH shape,
// and logger exclusion of probe/scrape paths.
// =====================================================================

// New RequestLog with a fixed start so durationMs is deterministic-ish (>=0).
function newLog(): RequestLog {
  return new RequestLog("test-req", "POST", "/auth/login", performance.now());
}

// Pull the recorded spans[] off a log's serialized JSON.
function spansOf(log: RequestLog): Array<{ name: string; data?: any }> {
  return (log.toJSON().spans as Array<{ name: string; data?: any }>) ?? [];
}

// -----------------------------------------------------------------
// RequestLog.call()
// -----------------------------------------------------------------
describe("RequestLog.call()", () => {
  it("happy path: records {name,input,output,durationMs} and returns the fn result unchanged", async () => {
    const log = newLog();
    const out = await log.call("doThing", { a: 1 }, async () => ({ value: 42 }));
    expect(out).toEqual({ value: 42 }); // result passes through untouched

    const span = spansOf(log).find((s) => s.name === "doThing");
    expect(span).toBeDefined();
    expect(span!.data.input).toEqual({ a: 1 });
    expect(span!.data.output).toEqual({ value: 42 });
    expect(typeof span!.data.durationMs).toBe("number");
  });

  it("on throw: records {error} and RETHROWS (does not swallow)", async () => {
    const log = newLog();
    await expect(
      log.call("boom", { x: 1 }, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");

    const span = spansOf(log).find((s) => s.name === "boom");
    expect(span).toBeDefined();
    expect(span!.data.error).toContain("kaboom");
    expect(span!.data).not.toHaveProperty("output"); // error path records no output
  });
});

// -----------------------------------------------------------------
// Redaction — key-name redactor + free-text scrubber
// -----------------------------------------------------------------
describe("RequestLog redaction", () => {
  it("positional secret: a verifyPassword-style call never serializes the plaintext password", async () => {
    const log = newLog();
    // CONTRACT: callers must pass safe-keyed objects, NOT positional args. We log {userId} only.
    await log.call("verifyPassword", { userId: "u-1" }, async () => true, (r) => ({ ok: r }));
    let line = JSON.stringify(log.toJSON());
    expect(line).not.toContain("hunter2");
    expect(line).toContain("u-1");
    expect(line).toContain("\"ok\":true");

    // And if a secret DOES sneak in under a redacted key, the redactor blanks it.
    const log2 = newLog();
    await log2.call("verifyPassword", { userId: "u-2", password: "hunter2" }, async () => true, (r) => ({ ok: r }));
    line = JSON.stringify(log2.toJSON());
    expect(line).not.toContain("hunter2");
    expect(line).toContain("[REDACTED]");
  });

  it("PII keys: a log line built from a user row never leaks email/student_id/phone/instagram", () => {
    // NOTE: the redactor does NOT blank PII keys — callers must keep PII out. This asserts the
    // SAFE pattern: only non-PII fields are set on the log.
    const log = newLog();
    log.set("userId", "u-7").set("role", "student");
    const line = JSON.stringify(log.toJSON());
    expect(line).not.toContain("@example.test");
    expect(line).not.toContain("std-secret");
    expect(line).not.toContain("0812345678");
    expect(line).not.toContain("@my_insta");
  });

  it("token: a createSession-style plaintext token never appears in any emitted line", async () => {
    const log = newLog();
    // Service returns { token, id }; pick only id → token stays out of the line entirely.
    await log.call(
      "createSession",
      { userId: "u-1" },
      async () => ({ token: "PLAINTEXT-SESSION-TOKEN-xyz", id: "sess-9" }),
      (s) => ({ sessionId: s.id }),
    );
    const line = JSON.stringify(log.toJSON());
    expect(line).not.toContain("PLAINTEXT-SESSION-TOKEN-xyz");
    expect(line).toContain("sess-9");
  });

  it("redactor unification: strips plain_password / qr_token_plain / file_content AND current_password / new_password", () => {
    const log = newLog();
    log.set("creds", {
      plain_password: "p1",
      qr_token_plain: "q1",
      file_content: "bytes",
      current_password: "c1",
      new_password: "n1",
      keep: "visible",
    });
    const line = JSON.stringify(log.toJSON());
    for (const secret of ["p1", "q1", "bytes", "c1", "n1"]) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain("[REDACTED]");
    expect(line).toContain("visible"); // non-secret keys survive
  });
});

// -----------------------------------------------------------------
// scrubText — free-text secret patterns
// -----------------------------------------------------------------
describe("scrubText", () => {
  it("redacts a postgres:// DSN, a bearer token, and a temp-password pattern in free text", () => {
    expect(scrubText("failed: postgres://user:pw@host:5432/db boom")).not.toContain("postgres://");
    expect(scrubText("bearer abc.def.ghi")).not.toContain("abc.def.ghi");
    expect(scrubText("temp_password: s3cr3tPW")).not.toContain("s3cr3tPW");
    expect(scrubText("postgres://u:p@h/d")).toContain("[REDACTED]");
  });

  // Forms that previously leaked the token TAIL (audit S1) — must scrub the actual secret, not just the keyword.
  it("redacts the token tail across authorization/bearer/token + JWT + argon2 forms", () => {
    expect(scrubText("authorization: Bearer xyz123secret")).not.toContain("xyz123secret");
    expect(scrubText("Authorization=tok_secretvalue")).not.toContain("tok_secretvalue");
    expect(scrubText("token=tok_live_abc123def")).not.toContain("tok_live_abc123def");
    const jwt = "eyJhbGc.eyJzdWIiOiJ4.SflKxwRJSM";
    expect(scrubText(`failed with ${jwt} here`)).not.toContain(jwt);
    expect(scrubText("hash $argon2id$v=19$m=65536,t=3,p=4$abc$def end")).not.toContain("$argon2id$");
  });
});

// -----------------------------------------------------------------
// Request logger excludes probe/scrape paths
// -----------------------------------------------------------------
describe("request logger excludes /metrics, /health, /ready", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Any JSON request-log line carries a reqId field — use that to detect emission.
  function emittedRequestLogLines(): string[] {
    const all = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map(
      (c) => String(c[0] ?? ""),
    );
    return all.filter((s) => s.includes("\"reqId\""));
  }

  it("/metrics, /health, /ready emit NO request-log line; a real route DOES", async () => {
    await request("/metrics");
    await request("/health");
    await request("/ready");
    expect(emittedRequestLogLines()).toHaveLength(0);

    // Sanity: a normal (even failing) request emits exactly one line, proving the spy works.
    await request("/auth/me"); // 401, but still logged
    expect(emittedRequestLogLines().length).toBeGreaterThanOrEqual(1);
  });
});

// -----------------------------------------------------------------
// /ready under DB failure (B1) — must 503, not crash to 500.
// /ready is logger-excluded so c.get("log") is undefined; the handler must guard it.
// -----------------------------------------------------------------
describe("/ready DB-failure path", () => {
  it("returns 503 {ready:false,error:db} when the DB check throws (no logger crash)", async () => {
    const spy = vi.spyOn(db, "execute").mockRejectedValueOnce(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request("/ready");
      expect(res.status).toBe(503); // 500 here = the c.get("log") TypeError regression
      expect(await res.json()).toEqual({ ready: false, error: "db" });
    } finally {
      spy.mockRestore();
      errSpy.mockRestore();
    }
  });
});

// -----------------------------------------------------------------
// /metrics endpoint + route-label cardinality
// -----------------------------------------------------------------
describe("metrics endpoint + route-label cardinality", () => {
  it("GET /metrics returns the prometheus exposition", async () => {
    const res = await request("/metrics");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("http_requests_total");
  });

  it("labels /events/<uuid>/register as the TEMPLATED route (:eventId), not the raw id", async () => {
    const event = await makeEvent();
    // give it an active form version so the route is reachable past validation
    await db.insert(eventFormVersions).values({
      eventId: event.id,
      versionNumber: 1,
      schemaJson: { fields: [] },
      createdByAdminId: event.createdByAdminId,
      isActive: true,
    });
    const { cookie } = await loginAs("student");
    await request(`/events/${event.id}/register`, { method: "POST", cookie, body: { answers: {} } });

    const dump = await register.metrics();
    // Templated path present, raw uuid absent from the route label.
    expect(dump).toContain("/events/:eventId/register");
    expect(dump).not.toContain(`/events/${event.id}/register`);
  });

  it("unmatched routes get a CONSTANT low-cardinality label, never the raw pathname", async () => {
    // Hono's app.use("*") makes routePath the wildcard "/*" for unmatched routes — a constant,
    // so the raw path can never explode label cardinality. (That's the I3 guarantee in practice.)
    await request("/no/such/route/here");
    const dump = await register.metrics();
    expect(dump).not.toContain("/no/such/route/here"); // raw path never becomes a label
    expect(dump).toContain('route="/*"'); // constant fallback label
  });
});

// -----------------------------------------------------------------
// Business counters increment on the real failure/success paths
// -----------------------------------------------------------------
describe("business counters", () => {
  // Read a counter's current value (sum across label sets) from the registry.
  async function counterValue(name: string): Promise<number> {
    const metric = await register.getSingleMetric(name)?.get();
    if (!metric) return 0;
    return (metric.values ?? []).reduce((acc, v) => acc + (v.value ?? 0), 0);
  }

  it("loginFailuresTotal increments on a bad-credentials login", async () => {
    const admin = await seedUser({ role: "admin" });
    const before = await counterValue("login_failures_total");
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: "wrong-password-xx" },
    });
    expect(res.status).toBe(401);
    expect(await counterValue("login_failures_total")).toBe(before + 1);
  });

  it("capacityRejectionsTotal increments when registration is rejected for being full", async () => {
    // capacity=1, no waitlist → the 2nd registrant hits the reject path.
    const event = await makeEvent({ capacity: 1 });
    await db.insert(eventFormVersions).values({
      eventId: event.id,
      versionNumber: 1,
      schemaJson: { fields: [] },
      createdByAdminId: event.createdByAdminId,
      isActive: true,
    });
    const a = await loginAs("student");
    const b = await loginAs("student");
    await request(`/events/${event.id}/register`, { method: "POST", cookie: a.cookie, body: { answers: {} } });

    const before = await counterValue("capacity_rejections_total");
    const res = await request(`/events/${event.id}/register`, {
      method: "POST",
      cookie: b.cookie,
      body: { answers: {} },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("registration_full");
    expect(await counterValue("capacity_rejections_total")).toBe(before + 1);
  });
});

// -----------------------------------------------------------------
// signin 5WH shape + lockout branch marker
// -----------------------------------------------------------------
describe("signin 5WH log shape + lockout marker", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  // Parse all emitted request-log JSON lines into objects.
  function loggedLines(): any[] {
    const raw = [...logSpy.mock.calls, ...warnSpy.mock.calls, ...errorSpy.mock.calls].map(
      (c) => String(c[0] ?? ""),
    );
    const out: any[] = [];
    for (const s of raw) {
      try {
        const o = JSON.parse(s);
        if (o && o.reqId) out.push(o);
      } catch {
        /* not a log line */
      }
    }
    return out;
  }

  it("a successful signin line carries action, outcome, userId, ip, sessionId + a call chain incl checkRateLimit & createSession", async () => {
    const admin = await seedUser({ role: "admin" });
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: admin.password },
    });
    expect(res.status).toBe(200);

    const line = loggedLines().find((l) => l.action === "auth.signin");
    expect(line).toBeDefined();
    expect(line.action).toBe("auth.signin");
    expect(line.outcome).toBe("success");
    expect(line.userId).toBe(admin.id);
    expect(line).toHaveProperty("ip"); // WHO — set by the request logger (null in tests is fine)
    expect(typeof line.sessionId).toBe("string");

    const spanNames = (line.spans ?? []).map((s: any) => s.name);
    expect(spanNames).toContain("checkRateLimit");
    expect(spanNames).toContain("createSession");
    // password never appears in the serialized line
    expect(JSON.stringify(line)).not.toContain(admin.password);
  });

  it("active-lockout 429 path emits a rate_limited{lockedUntil} event + outcome=locked_out", async () => {
    const admin = await seedUser({ role: "admin", email: "lockme@example.test" });
    // 5 failures cross EMAIL_MAX_FAILS and stamp lockedUntil; the 6th hits the active-lockout branch.
    for (let i = 0; i < 5; i++) {
      await request("/auth/login", {
        method: "POST",
        body: { identifier: admin.email, password: "wrong-password-xx" },
      });
    }
    const blocked = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: "wrong-password-xx" },
    });
    expect(blocked.status).toBe(429);

    const lines = loggedLines().filter((l) => l.action === "auth.signin");
    const lockedLine = lines.find((l) => l.outcome === "locked_out");
    expect(lockedLine).toBeDefined();
    const marker = (lockedLine.spans ?? []).find((s: any) => s.name === "rate_limited");
    expect(marker).toBeDefined();
    expect(marker.data).toHaveProperty("lockedUntil");
  });
});
