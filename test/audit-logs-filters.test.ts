import { describe, it, expect } from "vitest";
import { db } from "../src/db/client";
import { auditLogs } from "../src/db/schema/audit";
import { eventFormVersions } from "../src/db/schema/forms";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";

// ---------------------------------------------------------------------------
// Targets the MED-tier zero-coverage list filters on GET /admin/audit-logs:
// entity_type / event_id / target_user_id / from-to date window / AND-compose.
// (Only `action` + limit/offset were covered before — see audit-logs.test.ts.)
//
// We INSERT audit rows directly: createdAt is server-set by real actions, so
// direct insert is the only way to control timestamps for the date-window test
// and to seed precise entity_type/event_id/target_user_id combos. The wire
// endpoint just re-serializes stored rows, so insert == what the API filters.
// ---------------------------------------------------------------------------

// Insert one audit row with explicit filterable fields. createdAt overrides the
// column default so the from/to window test can place rows on a known timeline.
async function insertAudit(opts: {
  action: string;
  entityType: string;
  actorUserId: string;
  eventId?: string;
  targetUserId?: string;
  registrationId?: string;
  createdAt?: Date;
}): Promise<void> {
  await db.insert(auditLogs).values({
    action: opts.action,
    entityType: opts.entityType,
    actorUserId: opts.actorUserId,
    actorRole: "admin",
    eventId: opts.eventId,
    targetUserId: opts.targetUserId,
    registrationId: opts.registrationId,
    createdAt: opts.createdAt,
  });
}

type WireLog = {
  action: string;
  entity_type: string;
  event_id: string | null;
  target_user_id: string | null;
  created_at: string;
};

// Run the list endpoint with a query string and return the parsed logs.
async function listLogs(query: string, cookie: string): Promise<WireLog[]> {
  const res = await request(`/admin/audit-logs${query}`, { cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { logs: WireLog[] };
  return body.logs;
}

describe("audit-logs list filters: entity_type", () => {
  it("returns only rows whose entity_type matches", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    await insertAudit({ action: "a1", entityType: "user", actorUserId: admin.id });
    await insertAudit({ action: "a2", entityType: "user", actorUserId: admin.id });
    await insertAudit({ action: "a3", entityType: "event", actorUserId: admin.id });

    const logs = await listLogs("?entity_type=event", cookie);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.entity_type === "event")).toBe(true);
    // The two `user` rows must be filtered out entirely.
    expect(logs.some((l) => l.entity_type === "user")).toBe(false);
  });
});

describe("audit-logs list filters: event_id", () => {
  it("returns only rows for the requested event_id", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const eventA = await makeEvent({ createdByAdminId: admin.id });
    const eventB = await makeEvent({ createdByAdminId: admin.id });
    await insertAudit({ action: "ea1", entityType: "event", actorUserId: admin.id, eventId: eventA.id });
    await insertAudit({ action: "ea2", entityType: "event", actorUserId: admin.id, eventId: eventA.id });
    await insertAudit({ action: "eb1", entityType: "event", actorUserId: admin.id, eventId: eventB.id });

    const logs = await listLogs(`?event_id=${eventA.id}`, cookie);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.event_id === eventA.id)).toBe(true);
    expect(logs.some((l) => l.event_id === eventB.id)).toBe(false);
  });

  it("rejects a non-uuid event_id with 400 (zod .uuid() guard)", async () => {
    const { cookie } = await loginAs("admin");
    const res = await request("/admin/audit-logs?event_id=not-a-uuid", { cookie });
    expect(res.status).toBe(400);
  });
});

describe("audit-logs list filters: target_user_id", () => {
  it("returns only rows targeting the requested user", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const targetA = await seedUser({ role: "student", studentId: "tgt-a" });
    const targetB = await seedUser({ role: "student", studentId: "tgt-b" });
    await insertAudit({ action: "ta1", entityType: "user", actorUserId: admin.id, targetUserId: targetA.id });
    await insertAudit({ action: "tb1", entityType: "user", actorUserId: admin.id, targetUserId: targetB.id });

    const logs = await listLogs(`?target_user_id=${targetA.id}`, cookie);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.target_user_id === targetA.id)).toBe(true);
    expect(logs.some((l) => l.target_user_id === targetB.id)).toBe(false);
  });
});

describe("audit-logs list filters: from/to date window", () => {
  it("returns only rows whose created_at is within [from, to] (gte/lte branch)", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    // Build a fixed timeline: rows at -3d (before), -1d (inside), +1d (inside), +3d (after).
    const day = 24 * 60 * 60 * 1000;
    const base = Date.now();
    const before = new Date(base - 3 * day);
    const insideEarly = new Date(base - 1 * day);
    const insideLate = new Date(base + 1 * day);
    const after = new Date(base + 3 * day);

    await insertAudit({ action: "win-before", entityType: "user", actorUserId: admin.id, createdAt: before });
    await insertAudit({ action: "win-early", entityType: "user", actorUserId: admin.id, createdAt: insideEarly });
    await insertAudit({ action: "win-late", entityType: "user", actorUserId: admin.id, createdAt: insideLate });
    await insertAudit({ action: "win-after", entityType: "user", actorUserId: admin.id, createdAt: after });

    // Window spans the two inside rows; excludes the before/after rows.
    const from = new Date(base - 2 * day).toISOString();
    const to = new Date(base + 2 * day).toISOString();
    const logs = await listLogs(`?from=${from}&to=${to}`, cookie);

    const actions = logs.map((l) => l.action);
    expect(actions).toContain("win-early");
    expect(actions).toContain("win-late");
    expect(actions).not.toContain("win-before");
    expect(actions).not.toContain("win-after");

    // Every returned row's timestamp must fall inside the window (gte from, lte to).
    const fromMs = new Date(from).getTime();
    const toMs = new Date(to).getTime();
    for (const l of logs) {
      const t = new Date(l.created_at).getTime();
      expect(t).toBeGreaterThanOrEqual(fromMs);
      expect(t).toBeLessThanOrEqual(toMs);
    }
  });

  it("from-only filter excludes earlier rows (gte branch in isolation)", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const day = 24 * 60 * 60 * 1000;
    const base = Date.now();
    await insertAudit({ action: "fo-old", entityType: "user", actorUserId: admin.id, createdAt: new Date(base - 5 * day) });
    await insertAudit({ action: "fo-new", entityType: "user", actorUserId: admin.id, createdAt: new Date(base) });

    const from = new Date(base - 2 * day).toISOString();
    const logs = await listLogs(`?from=${from}`, cookie);
    const actions = logs.map((l) => l.action);
    expect(actions).toContain("fo-new");
    expect(actions).not.toContain("fo-old");
  });

  it("rejects a non-ISO `from` value with 400 (zod .datetime() guard)", async () => {
    const { cookie } = await loginAs("admin");
    const res = await request("/admin/audit-logs?from=2026-06-21", { cookie });
    expect(res.status).toBe(400); // bare date, not full datetime → rejected
  });
});

describe("audit-logs list filters: AND-compose", () => {
  it("action + target_user_id compose (both must match)", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const targetA = await seedUser({ role: "student", studentId: "and-a" });
    const targetB = await seedUser({ role: "student", studentId: "and-b" });
    // Same action across two targets + same target across two actions → only the
    // intersection (action=user_disabled AND target=A) should survive.
    await insertAudit({ action: "user_disabled", entityType: "user", actorUserId: admin.id, targetUserId: targetA.id });
    await insertAudit({ action: "user_disabled", entityType: "user", actorUserId: admin.id, targetUserId: targetB.id });
    await insertAudit({ action: "user_enabled", entityType: "user", actorUserId: admin.id, targetUserId: targetA.id });

    const logs = await listLogs(`?action=user_disabled&target_user_id=${targetA.id}`, cookie);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.action === "user_disabled" && l.target_user_id === targetA.id)).toBe(true);
    // Neither the other-target nor the other-action row may slip through.
    expect(logs.some((l) => l.target_user_id === targetB.id)).toBe(false);
    expect(logs.some((l) => l.action === "user_enabled")).toBe(false);
  });

  it("entity_type + event_id compose against a real audited action", async () => {
    // Mix a real audited action (over-capacity manual register) with seeded noise to
    // prove the filters work on rows the app actually writes, not just inserted ones.
    const { user: admin, cookie } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id, capacity: 1 });
    // active empty-field form so answers:{} validate clean (precondition for manual register)
    await db.insert(eventFormVersions).values({
      eventId: event.id,
      versionNumber: 1,
      schemaJson: { fields: [] },
      createdByAdminId: admin.id,
      isActive: true,
    });
    await makeRegistration({ event, status: "registered" }); // fill the one slot
    const student = await seedUser({ role: "student", studentId: "and-ev-1" });

    const res = await request(`/admin/events/${event.id}/registrations`, {
      method: "POST",
      cookie,
      body: { userId: student.id, answers: {}, reason: "VIP override" },
    });
    expect(res.status).toBe(201); // admin_register_over_capacity row written with eventId

    // Noise: a different entity_type on the same event must be excluded by entity_type.
    await insertAudit({ action: "noise", entityType: "user", actorUserId: admin.id, eventId: event.id });

    const logs = await listLogs(`?entity_type=registration&event_id=${event.id}`, cookie);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.entity_type === "registration" && l.event_id === event.id)).toBe(true);
    expect(logs.some((l) => l.action === "noise")).toBe(false);
  });
});
