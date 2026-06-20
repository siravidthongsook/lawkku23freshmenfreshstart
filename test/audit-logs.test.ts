import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { auditLogs } from "../src/db/schema/audit";
import { eventFormVersions } from "../src/db/schema/forms";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";
import type { Event } from "../src/db/schema/events";

// ---------------------------------------------------------------------------
// Local helpers (test-only). Read directly from the DB to assert what was
// actually STORED in audit rows — the wire endpoint only re-serializes them,
// so the DB is the source of truth for redaction / append-only checks.
// ---------------------------------------------------------------------------

// Active form version is the precondition for manual register (else `no_active_form`).
async function makeFormVersion(event: Event): Promise<void> {
  await db.insert(eventFormVersions).values({
    eventId: event.id,
    versionNumber: 1,
    schemaJson: { fields: [] }, // no fields → empty answers validate clean
    createdByAdminId: event.createdByAdminId,
    isActive: true,
  });
}

// Fetch the single audit row matching an action (newest first); throws if 0.
async function auditRowFor(action: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .orderBy(sql`${auditLogs.createdAt} desc`);
  if (rows.length === 0) throw new Error(`no audit row for action ${action}`);
  return rows[0]!;
}

async function countAuditRows(action?: string): Promise<number> {
  const where = action ? eq(auditLogs.action, action) : undefined;
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(auditLogs).where(where);
  return row?.c ?? 0;
}

// Serialize the entire stored row to a string and assert no secret substring appears.
// Covers reason/old_value/new_value/metadata JSON + every scalar column at once.
function assertNoSecret(row: unknown, secrets: string[]): void {
  const blob = JSON.stringify(row);
  for (const s of secrets) {
    expect(blob.includes(s), `audit row leaked secret: ${s}`).toBe(false);
  }
}

// ---------------------------------------------------------------------------
// Invariant 1 — append-only: only GET endpoints, writes go through writeAudit,
// performing an action makes exactly one new row, never mutated afterward.
// ---------------------------------------------------------------------------
describe("audit-logs: append-only", () => {
  it("module exposes no write/update/delete HTTP path (PUT/DELETE/POST → not 2xx)", async () => {
    const { cookie } = await loginAs("admin");
    // There is intentionally no mutating audit-log route. Any verb other than GET must not succeed.
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await request("/admin/audit-logs", { method, cookie });
      expect(res.status).not.toBe(200);
      expect(res.status).not.toBe(201);
    }
  });

  it("a sensitive action creates exactly one audit row of that action; re-reading never mutates it", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student" });

    expect(await countAuditRows("user_disabled")).toBe(0);
    const res = await request(`/admin/users/${target.id}/disable`, {
      method: "POST",
      cookie,
      body: { reason: "policy violation" },
    });
    expect(res.status).toBe(200);
    expect(await countAuditRows("user_disabled")).toBe(1);

    const row = await auditRowFor("user_disabled");
    expect(row.actorUserId).toBe(admin.id);

    // Read it back through the API twice — row count + the row itself stay identical (no mutation).
    await request("/admin/audit-logs", { cookie });
    await request("/admin/audit-logs", { cookie });
    expect(await countAuditRows("user_disabled")).toBe(1);
    const again = await auditRowFor("user_disabled");
    expect(again.id).toBe(row.id);
    expect(again.createdAt.getTime()).toBe(row.createdAt.getTime());
    expect(again.reason).toBe("policy violation");
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — sensitive actions require `reason`: REJECT 400 when missing,
// RECORD the reason when present.
// ---------------------------------------------------------------------------
describe("audit-logs: reason required on sensitive actions", () => {
  it("disable user without reason → 400, with no audit row written", async () => {
    const { cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student" });

    const res = await request(`/admin/users/${target.id}/disable`, {
      method: "POST",
      cookie,
      body: {}, // missing reason
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows("user_disabled")).toBe(0);
  });

  it("disable user WITH reason → 200 and the reason is stored verbatim", async () => {
    const { cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student" });

    const res = await request(`/admin/users/${target.id}/disable`, {
      method: "POST",
      cookie,
      body: { reason: "duplicate account" },
    });
    expect(res.status).toBe(200);
    const row = await auditRowFor("user_disabled");
    expect(row.reason).toBe("duplicate account");
  });

  it("reset-password without reason → 400, no admin_password_reset row", async () => {
    const { cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student", studentId: "rp-1" });

    const res = await request(`/admin/users/${target.id}/reset-password`, {
      method: "POST",
      cookie,
      body: { mode: "temp_password" }, // missing reason
    });
    expect(res.status).toBe(400);
    expect(await countAuditRows("admin_password_reset")).toBe(0);
  });

  it("admin manual register without reason → 400, no registration audit row", async () => {
    const { cookie } = await loginAs("admin");
    const event = await makeEvent();
    await makeFormVersion(event);
    const student = await seedUser({ role: "student", studentId: "mr-1" });

    const res = await request(`/admin/events/${event.id}/registrations`, {
      method: "POST",
      cookie,
      body: { userId: student.id, answers: {} }, // missing reason
    });
    expect(res.status).toBe(400);
    // The whole tx never ran → no registration_created row for this manual action.
    expect(await countAuditRows("registration_created")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — secret redaction: passwords / hashes / tokens / temp passwords
// must NEVER appear in any stored audit row.
// ---------------------------------------------------------------------------
describe("audit-logs: secret redaction", () => {
  it("reset-password (temp mode) audit row contains no plaintext temp password / hash", async () => {
    const { cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student", studentId: "rp-redact-1" });

    const res = await request(`/admin/users/${target.id}/reset-password`, {
      method: "POST",
      cookie,
      body: { reason: "forgot password", mode: "temp_password" },
    });
    expect(res.status).toBe(200);

    // Reveal the freshly-issued temp password so we have the real plaintext to search for.
    const revealRes = await request(`/admin/users/${target.id}/temp-password`, { cookie });
    expect(revealRes.status).toBe(200);
    const { temp_password } = (await revealRes.json()) as { temp_password: string };
    expect(temp_password.length).toBeGreaterThan(0);

    // Pull the user's current hash directly to ensure it never leaked either.
    const [u] = await db
      .select({ hash: sql<string | null>`password_hash` })
      .from(sql`users`)
      .where(sql`id = ${target.id}`);
    const hash = u?.hash ?? "";

    const resetRow = await auditRowFor("admin_password_reset");
    const revealRow = await auditRowFor("temp_password_revealed");

    const secrets = [temp_password];
    if (hash) secrets.push(hash);
    assertNoSecret(resetRow, secrets);
    assertNoSecret(revealRow, secrets);
    // reset row only records the non-secret mode; reveal row carries no value payload at all.
    expect(resetRow.newValue).toEqual({ mode: "temp_password" });
  });

  // The bulk temp-pw export was folded into /admin/users/export as an opt-in temp_password column.
  // Even when that column is exported, the audit row must carry only count/filter/columns — no plaintext.
  it("users export with temp_password column audits count/columns, never any password", async () => {
    const { cookie } = await loginAs("admin");
    // Create a temp-pw account so the export has a plaintext temp password to decrypt.
    const createRes = await request("/admin/users", {
      method: "POST",
      cookie,
      body: {
        full_name: "Export Target",
        role: "student",
        student_id: "exp-1",
        email: "exp-1@example.test",
        provision_mode: "temp_password",
      },
    });
    expect(createRes.status).toBe(201);

    // reason required now that temp_password (plaintext) is requested
    const exportRes = await request("/admin/users/export?columns=student_id,temp_password&reason=audit-check", { cookie });
    expect(exportRes.status).toBe(200);
    const csv = await exportRes.text();
    // Pull the decrypted plaintext temp passwords out of the CSV body to assert they never leaked to audit.
    const lines = csv.trim().split("\r\n");
    const header = lines[0]!.split(",");
    const tpIdx = header.indexOf("temp_password");
    const plaintexts = lines
      .slice(1)
      .map((l) => l.split(",")[tpIdx] ?? "")
      .filter((p) => p.length > 0);
    expect(plaintexts.length).toBeGreaterThan(0);

    const row = await auditRowFor("users_exported");
    assertNoSecret(row, plaintexts);
    // Audit metadata records the column list (key only) — the key name, never any value.
    const md = row.metadata as { columns?: string[] };
    expect(md.columns).toContain("temp_password");
  });

  it("redact helper masks a known secret key passed through user_created newValue", async () => {
    // user_created newValue records email/student_id/role/provision_mode only — assert the issued
    // temp password (revealed separately) never appears in the create audit row.
    const { cookie } = await loginAs("admin");
    const createRes = await request("/admin/users", {
      method: "POST",
      cookie,
      body: {
        full_name: "Create Redact",
        role: "student",
        student_id: "cr-1",
        email: "cr-1@example.test",
        provision_mode: "temp_password",
      },
    });
    expect(createRes.status).toBe(201);
    const { user } = (await createRes.json()) as { user: { id: string } };

    const reveal = await request(`/admin/users/${user.id}/temp-password`, { cookie });
    const { temp_password } = (await reveal.json()) as { temp_password: string };

    const row = await auditRowFor("user_created");
    assertNoSecret(row, [temp_password]);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 — correct actor + target + action; references by user_id.
// ---------------------------------------------------------------------------
describe("audit-logs: actor / target / action correctness", () => {
  it("user_disabled records admin as actor, target user_id, correct action code (by id, not email)", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student", studentId: "at-1", email: "at-1@example.test" });

    const res = await request(`/admin/users/${target.id}/disable`, {
      method: "POST",
      cookie,
      body: { reason: "spam" },
    });
    expect(res.status).toBe(200);

    const row = await auditRowFor("user_disabled");
    expect(row.action).toBe("user_disabled");
    expect(row.actorUserId).toBe(admin.id);
    expect(row.targetUserId).toBe(target.id);
    expect(row.entityId).toBe(target.id);
    expect(row.entityType).toBe("user");
    expect(row.actorRole).toBe("admin");
    // References by user_id only — never by email.
    assertNoSecret(row, [target.email!]);
  });

  it("manual register over capacity logs admin_register_over_capacity with actor+target+reason", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id, capacity: 1 });
    await makeFormVersion(event);
    // Fill the one capacity slot so the next manual register is over-capacity.
    await makeRegistration({ event, status: "registered" });
    const student = await seedUser({ role: "student", studentId: "oc-1" });

    const res = await request(`/admin/events/${event.id}/registrations`, {
      method: "POST",
      cookie,
      body: { userId: student.id, answers: {}, reason: "VIP override" },
    });
    expect(res.status).toBe(201);

    const row = await auditRowFor("admin_register_over_capacity");
    expect(row.actorUserId).toBe(admin.id);
    expect(row.targetUserId).toBe(student.id);
    expect(row.eventId).toBe(event.id);
    expect(row.registrationId).toBeTruthy();
    expect(row.reason).toBe("VIP override");
    expect(row.metadata).toMatchObject({ limit: 1 });
  });
});

// ---------------------------------------------------------------------------
// Invariant 5 — read endpoints: list (filter/paginate, newest-first) +
// per-registration history. (Permission gating itself covered by matrix suite.)
// ---------------------------------------------------------------------------
describe("audit-logs: read endpoints", () => {
  it("GET /admin/audit-logs returns rows for admin, newest-first, with total/limit/offset", async () => {
    const { cookie } = await loginAs("admin");
    const a = await seedUser({ role: "student", studentId: "rd-a" });
    const b = await seedUser({ role: "student", studentId: "rd-b" });

    await request(`/admin/users/${a.id}/disable`, { method: "POST", cookie, body: { reason: "first" } });
    await request(`/admin/users/${b.id}/disable`, { method: "POST", cookie, body: { reason: "second" } });

    const res = await request("/admin/audit-logs", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      logs: { action: string; created_at: string }[];
      total: number;
      limit: number;
      offset: number;
    };
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.limit).toBe(50);
    expect(body.offset).toBe(0);
    // Newest first: created_at is non-increasing.
    for (let i = 1; i < body.logs.length; i++) {
      expect(new Date(body.logs[i - 1]!.created_at).getTime()).toBeGreaterThanOrEqual(
        new Date(body.logs[i]!.created_at).getTime(),
      );
    }
  });

  it("GET /admin/audit-logs?action= filters to that action only", async () => {
    const { cookie } = await loginAs("admin");
    const t = await seedUser({ role: "student", studentId: "flt-1" });
    await request(`/admin/users/${t.id}/disable`, { method: "POST", cookie, body: { reason: "x" } });
    await request(`/admin/users/${t.id}/enable`, { method: "POST", cookie });

    const res = await request("/admin/audit-logs?action=user_enabled", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: { action: string }[] };
    expect(body.logs.length).toBeGreaterThan(0);
    expect(body.logs.every((l) => l.action === "user_enabled")).toBe(true);
  });

  it("GET /admin/audit-logs?limit/offset paginates", async () => {
    const { cookie } = await loginAs("admin");
    // Generate >1 distinct audit rows.
    for (let i = 0; i < 3; i++) {
      const u = await seedUser({ role: "student", studentId: `pg-${i}` });
      await request(`/admin/users/${u.id}/disable`, { method: "POST", cookie, body: { reason: "p" } });
    }
    const res = await request("/admin/audit-logs?limit=2&offset=0", { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: unknown[]; limit: number };
    expect(body.limit).toBe(2);
    expect(body.logs.length).toBe(2);
  });

  it("GET /admin/registrations/:id/audit-logs returns that registration's history", async () => {
    const { cookie } = await loginAs("admin");
    const reg = await makeRegistration({ status: "registered" });
    await request(`/admin/registrations/${reg.id}/cancel`, {
      method: "POST",
      cookie,
      body: { reason: "no-show cleanup" },
    });

    const res = await request(`/admin/registrations/${reg.id}/audit-logs`, { cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { logs: { registration_id: string; action: string }[] };
    expect(body.logs.length).toBeGreaterThan(0);
    expect(body.logs.every((l) => l.registration_id === reg.id)).toBe(true);
    expect(body.logs.some((l) => l.action === "registration_cancelled")).toBe(true);
  });

  it("GET /admin/registrations/:id/audit-logs → 404 for unknown registration", async () => {
    const { cookie } = await loginAs("admin");
    const res = await request(
      "/admin/registrations/00000000-0000-0000-0000-000000000000/audit-logs",
      { cookie },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe("not_found");
    expect(typeof body.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// Invariant 6 — audit written inside the same tx: a failed action rolls back
// the audit row too (no orphan). Cheaply assertable via the dedup conflict path.
// ---------------------------------------------------------------------------
describe("audit-logs: written inside the action transaction (rollback safety)", () => {
  it("manual register that 409s on already_registered writes NO registration_created row", async () => {
    const { cookie } = await loginAs("admin");
    const event = await makeEvent();
    await makeFormVersion(event);
    const student = await seedUser({ role: "student", studentId: "tx-1" });
    // Pre-existing active registration for this (event,user) → the manual register tx must conflict.
    await makeRegistration({ event, user: student, status: "registered" });

    const before = await countAuditRows("registration_created");
    const res = await request(`/admin/events/${event.id}/registrations`, {
      method: "POST",
      cookie,
      body: { userId: student.id, answers: {}, reason: "dup attempt" },
    });
    expect(res.status).toBe(409);
    // Conflict is thrown inside the tx after the event row-lock but before any audit write,
    // and the tx rolls back → audit count unchanged (no orphan row).
    expect(await countAuditRows("registration_created")).toBe(before);
  });
});
