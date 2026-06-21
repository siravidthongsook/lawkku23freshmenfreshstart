import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations } from "../src/db/schema/registrations";
import { registrationQrTokens } from "../src/db/schema/qr";
import { auditLogs } from "../src/db/schema/audit";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";
import { hashToken } from "../src/lib/crypto";
import { events as eventsTable } from "../src/db/schema/events";
import { eventPointConfig, pointSettings } from "../src/db/schema/point-config";
import { pointLedger } from "../src/db/schema/points";
import { users } from "../src/db/schema/users";
import { sql } from "drizzle-orm";
import type { Event } from "../src/db/schema/events";

// ---------------------------------------------------------------------------
// Local helpers (test-only). The scan path needs a REAL scannable token, which
// only the register handler mints. So we self-register a student to get the
// plaintext qrToken back, then scan it as staff. An active form version is the
// hard precondition for /register (else no_active_form), so we seed one.
// ---------------------------------------------------------------------------

// Seed the active form version /register requires. Empty schema → body {} validates clean.
async function makeFormVersion(event: Event): Promise<void> {
  await db.insert(eventFormVersions).values({
    eventId: event.id,
    versionNumber: 1,
    schemaJson: { fields: [] },
    createdByAdminId: event.createdByAdminId,
    isActive: true,
  });
}

// Published event with a form version → reachable by self-register. checkinOpen/Close default
// null → check-in window is unbounded (always open), so scans succeed unless we set bounds.
async function makeCheckinEvent(opts: Parameters<typeof makeEvent>[0] = {}): Promise<Event> {
  const event = await makeEvent({ status: "published", ...opts });
  await makeFormVersion(event);
  return event;
}

// Self-register a fresh student on an event → returns the plaintext qrToken + reg id + cookie.
// This is the only path that hands back a real scannable token.
async function registerStudent(
  event: Event,
): Promise<{ qrToken: string; registrationId: string; cookie: string; userId: string }> {
  const { user, cookie } = await loginAs("student");
  const res = await request(`/events/${event.id}/register`, {
    method: "POST",
    cookie,
    body: { answers: {} },
  });
  if (res.status !== 201) throw new Error(`registerStudent expected 201, got ${res.status}`);
  const body = (await res.json()) as {
    registration: { id: string };
    qrToken: string | null;
  };
  if (!body.qrToken) throw new Error("registerStudent: no qrToken returned");
  return { qrToken: body.qrToken, registrationId: body.registration.id, cookie, userId: user.id };
}

// POST a scan as a given staff/admin cookie. scanType "out" runs the scan-out flow.
function scan(eventId: string, qrToken: string, cookie?: string, scanType?: "in" | "out") {
  return request(`/events/${eventId}/checkins/scan`, {
    method: "POST",
    cookie,
    body: { qr_token: qrToken, ...(scanType ? { scan_type: scanType } : {}) },
  });
}

// Enable scan-out on an event with a window open NOW (mirrors points-checkin.test.ts).
async function enableCheckout(eventId: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(eventPointConfig)
    .values({
      eventId,
      checkinOutEnabled: true,
      scanOutOpenAt: new Date(now - 60 * 60 * 1000),
      scanOutCloseAt: new Date(now + 24 * 60 * 60 * 1000),
    })
    .onConflictDoUpdate({
      target: eventPointConfig.eventId,
      set: {
        checkinOutEnabled: true,
        scanOutOpenAt: new Date(now - 60 * 60 * 1000),
        scanOutCloseAt: new Date(now + 24 * 60 * 60 * 1000),
      },
    });
}

// Set the global points cutoff in the past (singleton row id=1) → student earning is frozen.
async function setPastCutoff(): Promise<void> {
  const past = new Date(Date.now() - 60_000);
  await db
    .insert(pointSettings)
    .values({ id: 1, cutoffAt: past })
    .onConflictDoUpdate({ target: pointSettings.id, set: { cutoffAt: past } });
}

// Read the qr_tokens rows for a registration directly (to assert hash-not-plaintext + active count).
async function qrRows(registrationId: string) {
  return db
    .select()
    .from(registrationQrTokens)
    .where(eq(registrationQrTokens.registrationId, registrationId));
}

async function activeQrRows(registrationId: string) {
  return db
    .select()
    .from(registrationQrTokens)
    .where(
      and(
        eq(registrationQrTokens.registrationId, registrationId),
        eq(registrationQrTokens.status, "active"),
      ),
    );
}

async function getReg(registrationId: string) {
  const [row] = await db.select().from(registrations).where(eq(registrations.id, registrationId));
  return row;
}

// =====================================================================
// INVARIANT 1 + 2: opaque token, no PII; hash stored not plaintext
// =====================================================================

describe("checkins: QR token is opaque + only hash is persisted", () => {
  it("issued token is opaque random — contains no email/student_id/PII", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, userId } = await registerStudent(event);

    // The student's identity must NOT be derivable from the token string.
    // base64url opaque value (generateToken → 32 random bytes → 43 chars). No PII substrings.
    expect(qrToken).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(qrToken.length).toBeGreaterThanOrEqual(40);
    expect(qrToken.toLowerCase()).not.toContain("@");
    expect(qrToken.toLowerCase()).not.toContain("std-");
    expect(qrToken).not.toContain(userId); // not derived from the user uuid
  });

  it("qr_tokens row stores a SHA-256 HASH, never the plaintext token", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);

    const rows = await qrRows(registrationId);
    expect(rows.length).toBe(1);
    const row = rows[0]!;

    // Stored hash differs from the plaintext, equals SHA-256(plaintext), and plaintext is absent.
    expect(row.tokenHash).not.toBe(qrToken);
    expect(row.tokenHash).toBe(hashToken(qrToken));
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
    // tokenEnc holds the encrypted plaintext for owner re-display — must NOT be plaintext either.
    expect(row.tokenEnc).toBeTruthy();
    expect(row.tokenEnc).not.toBe(qrToken);
  });
});

// =====================================================================
// INVARIANT 3: max 1 active token per registration (regenerate path)
// =====================================================================

describe("checkins: max 1 active token per registration", () => {
  it("admin regenerate revokes the prior active token — only one active at a time", async () => {
    const event = await makeCheckinEvent();
    const { qrToken: firstToken, registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");

    const regen = await request(`/admin/registrations/${registrationId}/qr/regenerate`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "lost phone" },
    });
    expect(regen.status).toBe(200);
    const newToken = ((await regen.json()) as { qrToken: string }).qrToken;
    expect(newToken).not.toBe(firstToken); // a fresh secret

    // Exactly one active row; the old one is revoked (two rows total, one active).
    const all = await qrRows(registrationId);
    expect(all.length).toBe(2);
    const active = await activeQrRows(registrationId);
    expect(active.length).toBe(1);
    expect(active[0]!.tokenHash).toBe(hashToken(newToken)); // the active one is the NEW token
  });

  it("scanning the OLD (revoked) token after regenerate → qr_revoked; new token works", async () => {
    const event = await makeCheckinEvent();
    const { qrToken: oldToken, registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");

    const regen = await request(`/admin/registrations/${registrationId}/qr/regenerate`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "rotate" },
    });
    const newToken = ((await regen.json()) as { qrToken: string }).qrToken;

    // Old token is now revoked → rejected (200 with result code, never marks success).
    const staff = await loginAs("checkin_staff");
    const oldScan = await scan(event.id, oldToken, staff.cookie);
    expect(oldScan.status).toBe(200);
    expect((await oldScan.json()) as { result: string }).toMatchObject({ result: "qr_revoked" });
    expect((await getReg(registrationId))!.status).toBe("registered"); // NOT checked in

    // New token still checks in.
    const newScan = await scan(event.id, newToken, staff.cookie);
    expect((await newScan.json()) as { result: string }).toMatchObject({
      result: "checked_in_success",
    });
  });
});

// =====================================================================
// INVARIANT 4: scan → checked_in; rescan → already_checked_in (no double)
// =====================================================================

describe("checkins: scan marks checked_in (UTC), second scan is idempotent", () => {
  it("staff scans a valid token → checked_in + checked_in_at set (UTC) + checkin_method qr_scan", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const before = Date.now();
    const res = await scan(event.id, qrToken, staff.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; checkedInAt: string; registrationId: string };
    expect(body.result).toBe("checked_in_success");
    expect(body.registrationId).toBe(registrationId);
    expect(body.checkedInAt).toBeTruthy();

    const reg = (await getReg(registrationId))!;
    expect(reg.status).toBe("checked_in");
    expect(reg.checkedInAt).not.toBeNull();
    expect(reg.checkinMethod).toBe("qr_scan");
    expect(reg.checkedInByUserId).toBe(staff.user.id);
    // checked_in_at stored as a real timestamp around now (UTC; ISO round-trips).
    const ts = reg.checkedInAt!.getTime();
    expect(ts).toBeGreaterThanOrEqual(before - 2000);
    expect(ts).toBeLessThanOrEqual(Date.now() + 2000);
    void userId;
  });

  it("scan writes a qr_scan_checkin audit row", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.registrationId, registrationId));
    expect(audits.some((a) => a.action === "qr_scan_checkin")).toBe(true);
  });

  it("scanning the SAME valid token twice → second is already_checked_in (no second check-in)", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const first = await scan(event.id, qrToken, staff.cookie);
    expect((await first.json()) as { result: string }).toMatchObject({
      result: "checked_in_success",
    });
    const firstReg = (await getReg(registrationId))!;
    const firstTime = firstReg.checkedInAt!.getTime();

    const second = await scan(event.id, qrToken, staff.cookie);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { result: string; originalCheckedInAt: string };
    expect(body.result).toBe("already_checked_in");
    expect(body.originalCheckedInAt).toBeTruthy(); // surfaces the ORIGINAL time

    // No re-stamp: checked_in_at unchanged on the second scan.
    const secondReg = (await getReg(registrationId))!;
    expect(secondReg.checkedInAt!.getTime()).toBe(firstTime);
  });

  it("admin can also scan (not just staff) → checked_in_success", async () => {
    const event = await makeCheckinEvent();
    const { qrToken } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await scan(event.id, qrToken, admin.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({
      result: "checked_in_success",
    });
  });
});

// =====================================================================
// INVARIANT 5: scan auth gate (light — the permission-matrix suite owns this)
// =====================================================================

describe("checkins: scan authorization gate", () => {
  it("student scanning → 403", async () => {
    const event = await makeCheckinEvent();
    const { qrToken } = await registerStudent(event);
    const student = await loginAs("student");
    const res = await scan(event.id, qrToken, student.cookie);
    expect(res.status).toBe(403);
  });

  it("anonymous scanning → 401", async () => {
    const event = await makeCheckinEvent();
    const { qrToken } = await registerStudent(event);
    const res = await scan(event.id, qrToken); // no cookie
    expect(res.status).toBe(401);
  });
});

// =====================================================================
// INVARIANT 6: invalid / revoked / cancelled-reg rejection
// =====================================================================

describe("checkins: invalid / revoked / ineligible token rejection", () => {
  it("unknown token → qr_invalid (no row touched)", async () => {
    const event = await makeCheckinEvent();
    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, "totally-not-a-real-token", staff.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "qr_invalid" });
  });

  it("admin-revoked token → qr_revoked, registration stays registered", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");

    const revoke = await request(`/admin/registrations/${registrationId}/qr/revoke`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "compromised" },
    });
    expect(revoke.status).toBe(200);

    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "qr_revoked" });
    expect((await getReg(registrationId))!.status).toBe("registered");
  });

  it("token of a CANCELLED registration → revoked-on-cancel surfaces as qr_revoked", async () => {
    // Student cancel revokes the active token, so a scan hits the qr_revoked branch first.
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, cookie } = await registerStudent(event);

    // Enable student cancel on this event, then cancel.
    await db
      .update(eventsTable)
      .set({ allowStudentCancelRegistration: true })
      .where(eq(eventsTable.id, event.id));
    const cancel = await request(`/registrations/${registrationId}/cancel`, {
      method: "POST",
      cookie,
    });
    expect(cancel.status).toBe(200);

    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect(res.status).toBe(200);
    // Active token was revoked at cancel time → qr_revoked (never checked_in_success).
    expect((await res.json()) as { result: string }).toMatchObject({ result: "qr_revoked" });
    expect((await getReg(registrationId))!.status).toBe("cancelled");
  });

  it("scan against an event whose check-in window has not opened → checkin_not_open", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const event = await makeCheckinEvent({ checkinOpenAt: future });
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "checkin_not_open" });
    expect((await getReg(registrationId))!.status).toBe("registered");
  });

  it("scan against an event whose check-in window has closed → checkin_closed", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const event = await makeCheckinEvent({ checkinCloseAt: past });
    const { qrToken } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "checkin_closed" });
  });

  // Blank checkinCloseAt falls back to eventEndAt: scan-in must not outlast the event.
  it("blank checkinCloseAt + PAST eventEndAt → checkin_closed (scan-in ends at event end)", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const event = await makeCheckinEvent({ checkinOpenAt: new Date(Date.now() - 120 * 60 * 1000), eventEndAt: past });
    const { qrToken } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "checkin_closed" });
  });

  // Blank checkinCloseAt + FUTURE eventEndAt → still open.
  it("blank checkinCloseAt + FUTURE eventEndAt → checked_in_success", async () => {
    const event = await makeCheckinEvent({ checkinOpenAt: new Date(Date.now() - 60 * 60 * 1000), eventEndAt: new Date(Date.now() + 60 * 60 * 1000) });
    const { qrToken } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "checked_in_success" });
  });
});

// =====================================================================
// INVARIANT 7: manual check-in (canManualCheckin) — works + audited
// =====================================================================

describe("checkins: manual check-in by registration id", () => {
  it("staff manual-checkin a registered reg → checked_in + checkin_method manual_search + audit", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const res = await request(`/registrations/${registrationId}/manual-checkin`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { result: string }).toMatchObject({
      result: "checked_in_success",
    });

    const reg = (await getReg(registrationId))!;
    expect(reg.status).toBe("checked_in");
    expect(reg.checkinMethod).toBe("manual_search");
    expect(reg.checkedInByUserId).toBe(staff.user.id);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.registrationId, registrationId));
    expect(audits.some((a) => a.action === "manual_checkin")).toBe(true);
  });

  it("manual-checkin an already-checked-in reg → 400 already_checked_in", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // first check in via scan

    const res = await request(`/registrations/${registrationId}/manual-checkin`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "already_checked_in" });
  });

  it("student calling manual-checkin → 403", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const student = await loginAs("student");
    const res = await request(`/registrations/${registrationId}/manual-checkin`, {
      method: "POST",
      cookie: student.cookie,
    });
    expect(res.status).toBe(403);
  });

  it("manual-checkin when the check-in window is not open → 400 checkin_not_open", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000);
    const event = await makeCheckinEvent({ checkinOpenAt: future });
    const { registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const res = await request(`/registrations/${registrationId}/manual-checkin`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "checkin_not_open" });
  });

  it("undo-checkin (reason required) reverts checked_in → registered + revokes nothing extra", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie);
    expect((await getReg(registrationId))!.status).toBe("checked_in");

    const undo = await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "scanned wrong person" },
    });
    expect(undo.status).toBe(200);
    const reg = (await getReg(registrationId))!;
    expect(reg.status).toBe("registered");
    expect(reg.checkedInAt).toBeNull();
    expect(reg.checkinMethod).toBeNull();
  });

  it("undo-checkin without a reason → 400 (reason is required)", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie);

    const undo = await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: {}, // missing reason → Zod 400
    });
    expect(undo.status).toBe(400);
  });
});

// =====================================================================
// INVARIANT 8: cross-event token rejection
// =====================================================================

describe("checkins: cross-event scan rejection", () => {
  it("a token issued for event A scanned at event B → wrong_event (A's reg untouched)", async () => {
    const eventA = await makeCheckinEvent();
    const eventB = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(eventA);
    const staff = await loginAs("checkin_staff");

    const res = await scan(eventB.id, qrToken, staff.cookie); // scanned at the WRONG event
    expect(res.status).toBe(200);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "wrong_event" });

    // The event-A registration must remain registered (no cross-event check-in).
    expect((await getReg(registrationId))!.status).toBe("registered");
  });

  it("the same token DOES check in at its own event after a wrong-event attempt", async () => {
    const eventA = await makeCheckinEvent();
    const eventB = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(eventA);
    const staff = await loginAs("checkin_staff");

    await scan(eventB.id, qrToken, staff.cookie); // rejected at B
    const ok = await scan(eventA.id, qrToken, staff.cookie); // succeeds at A
    expect((await ok.json()) as { result: string }).toMatchObject({
      result: "checked_in_success",
    });
    expect((await getReg(registrationId))!.status).toBe("checked_in");
  });

  // PII guard: a wrong_event scan must NOT de-anonymize the student cross-event (no name/student_id).
  it("wrong_event response OMITS fullName + studentId (no cross-event PII leak)", async () => {
    const eventA = await makeCheckinEvent();
    const eventB = await makeCheckinEvent();
    const { qrToken } = await registerStudent(eventA);
    const staff = await loginAs("checkin_staff");

    const res = await scan(eventB.id, qrToken, staff.cookie); // scanned at the WRONG event
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: string;
      fullName?: unknown;
      studentId?: unknown;
    };
    expect(body.result).toBe("wrong_event");
    // Identity fields must be absent (not merely null) — they are only attached after the event matches.
    expect(body.fullName).toBeUndefined();
    expect(body.studentId).toBeUndefined();
    expect("fullName" in body).toBe(false);
    expect("studentId" in body).toBe(false);
  });
});

// =====================================================================
// Waitlisted registration: no QR issued, manual-checkin blocked
// =====================================================================

describe("checkins: waitlisted registrations cannot check in", () => {
  it("manual-checkin a waitlisted reg → 400 waitlisted_not_allowed", async () => {
    const event = await makeCheckinEvent();
    const reg = await makeRegistration({ event, status: "waitlisted" });
    const staff = await loginAs("checkin_staff");
    const res = await request(`/registrations/${reg.id}/manual-checkin`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "waitlisted_not_allowed",
    });
  });
});

// =====================================================================
// SCAN OUT: ineligible-reg + cutoff rejects (the IN path tests these,
// the OUT path was uncovered).
// =====================================================================

describe("checkins: scan-out reject paths", () => {
  // Cancelled/waitlisted are rejected for OUT before the OUT block (common reject). We flip the reg
  // status directly so the active token survives (student-cancel would revoke it → qr_revoked instead).
  it("scan-OUT on a CANCELLED registration → registration_cancelled", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId } = await registerStudent(event);
    await db
      .update(registrations)
      .set({ status: "cancelled" })
      .where(eq(registrations.id, registrationId));

    const staff = await loginAs("checkin_staff");
    const out = await scan(event.id, qrToken, staff.cookie, "out");
    expect(out.status).toBe(200);
    expect((await out.json()) as { result: string }).toMatchObject({
      result: "registration_cancelled",
    });
  });

  it("scan-OUT on a WAITLISTED registration → waitlisted_not_allowed", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId } = await registerStudent(event);
    await db
      .update(registrations)
      .set({ status: "waitlisted" })
      .where(eq(registrations.id, registrationId));

    const staff = await loginAs("checkin_staff");
    const out = await scan(event.id, qrToken, staff.cookie, "out");
    expect(out.status).toBe(200);
    expect((await out.json()) as { result: string }).toMatchObject({
      result: "waitlisted_not_allowed",
    });
  });

  // Cutoff freeze blocks the OUT scan entirely (it only exists to award points) → points_closed.
  it("scan-OUT past the points cutoff_at → points_closed (no checkout)", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN first (still before cutoff)

    await setPastCutoff();
    const out = await scan(event.id, qrToken, staff.cookie, "out");
    expect(out.status).toBe(200);
    expect((await out.json()) as { result: string }).toMatchObject({ result: "points_closed" });
    // No checkout stamp written when frozen.
    expect((await getReg(registrationId))!.checkedOutAt).toBeNull();
  });
});

// =====================================================================
// Non-published event: scan rejects + manual throws event_not_published.
// (Reg + token are minted on a published event, then the event is flipped.)
// =====================================================================

describe("checkins: non-published (draft/archived) event is not check-in-capable", () => {
  it("scan against a DRAFT event → event_not_published (reg stays registered)", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId } = await registerStudent(event);
    await db.update(eventsTable).set({ status: "draft" }).where(eq(eventsTable.id, event.id));

    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()) as { result: string }).toMatchObject({
      result: "event_not_published",
    });
    expect((await getReg(registrationId))!.status).toBe("registered");
  });

  it("scan against an ARCHIVED event → event_not_published", async () => {
    const event = await makeCheckinEvent();
    const { qrToken } = await registerStudent(event);
    await db.update(eventsTable).set({ status: "archived" }).where(eq(eventsTable.id, event.id));

    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({
      result: "event_not_published",
    });
  });

  it("manual-checkin against a DRAFT event → 400 event_not_published", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    await db.update(eventsTable).set({ status: "draft" }).where(eq(eventsTable.id, event.id));

    const staff = await loginAs("checkin_staff");
    const res = await request(`/registrations/${registrationId}/manual-checkin`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "event_not_published",
    });
  });
});

// =====================================================================
// Undo clears the scan-out stamp too (the check-in it depended on is gone).
// =====================================================================

describe("checkins: undo clears scan-out stamps", () => {
  it("undo of an IN+OUT reg nulls checkedOutAt AND checkedOutByUserId", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await scan(event.id, qrToken, staff.cookie); // IN
    const out = await scan(event.id, qrToken, staff.cookie, "out"); // OUT
    expect((await out.json()) as { result: string }).toMatchObject({ result: "checked_out_success" });
    const checkedOut = (await getReg(registrationId))!;
    expect(checkedOut.checkedOutAt).not.toBeNull();
    expect(checkedOut.checkedOutByUserId).toBe(staff.user.id);

    const undo = await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "scanned wrong person" },
    });
    expect(undo.status).toBe(200);

    const reg = (await getReg(registrationId))!;
    expect(reg.status).toBe("registered");
    expect(reg.checkedOutAt).toBeNull();
    expect(reg.checkedOutByUserId).toBeNull();
  });
});

// ---- ledger/balance helpers for the new blocks (mirror points-checkin.test.ts) ----
async function balanceOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.pointsBalance }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function ledgerSum(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${pointLedger.delta}),0)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  return r!.s;
}
async function ledgerRowsOf(userId: string) {
  return db.select().from(pointLedger).where(eq(pointLedger.userId, userId));
}
async function auditRowsOf(registrationId: string) {
  return db.select().from(auditLogs).where(eq(auditLogs.registrationId, registrationId));
}
// Send a scan with dry_run:true (preview-only) for either direction.
function dryScan(eventId: string, qrToken: string, cookie: string, scanType: "in" | "out") {
  return request(`/events/${eventId}/checkins/scan`, {
    method: "POST",
    cookie,
    body: { qr_token: qrToken, scan_type: scanType, dry_run: true },
  });
}

// =====================================================================
// dry_run preview = NO mutation (invariant). The highest-value gap:
// a preview runs the full validation ladder but MUST commit nothing —
// no reg stamp, no point_ledger row, no audit row. Drives the confirm dialog.
// =====================================================================

describe("checkins: dry_run preview commits NOTHING (in + out)", () => {
  it("dry_run scan-IN → ready + identity + status, and writes no reg stamp / ledger / audit", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    // Baseline: register already wrote a "registration" audit row → dry_run must add NOTHING beyond it.
    const baselineAudit = (await auditRowsOf(registrationId)).length;

    const res = await dryScan(event.id, qrToken, staff.cookie, "in");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: string;
      registrationId: string;
      fullName?: string | null;
      studentId?: string | null;
      status?: string;
    };
    // Preview returns "ready" + the identity + the current status the confirm dialog needs.
    expect(body.result).toBe("ready");
    expect(body.registrationId).toBe(registrationId);
    expect("fullName" in body).toBe(true); // identity attached for the confirm dialog
    expect(body.status).toBe("registered"); // current (pre-commit) status surfaced

    // NO mutation: reg still registered with no check-in stamp.
    const reg = (await getReg(registrationId))!;
    expect(reg.status).toBe("registered");
    expect(reg.checkedInAt).toBeNull();
    expect(reg.checkedInByUserId).toBeNull();
    expect(reg.checkinMethod).toBeNull();
    // NO point ledger row + balance untouched.
    expect((await ledgerRowsOf(userId)).length).toBe(0);
    expect(await balanceOf(userId)).toBe(0);
    // NO new audit row from the preview (only the pre-existing registration audit remains).
    expect((await auditRowsOf(registrationId)).length).toBe(baselineAudit);
    const audits = await auditRowsOf(registrationId);
    expect(audits.some((a) => a.action === "qr_scan_checkin")).toBe(false);
  });

  it("dry_run scan-OUT (after a real IN) → ready, and writes no checkout stamp / OUT ledger / OUT audit", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    // Real IN first (OUT preview needs an existing check-in to reach the "ready" branch).
    await scan(event.id, qrToken, staff.cookie);
    const afterInLedger = (await ledgerRowsOf(userId)).length; // 1 (the IN award)
    const afterInAudit = (await auditRowsOf(registrationId)).length; // qr_scan_checkin
    const balanceAfterIn = await balanceOf(userId);

    const res = await dryScan(event.id, qrToken, staff.cookie, "out");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; registrationId: string; status?: string };
    expect(body.result).toBe("ready");
    expect(body.registrationId).toBe(registrationId);
    expect(body.status).toBe("checked_in"); // current status surfaced for the confirm dialog

    // NO checkout mutation: the IN survives, but no OUT stamp written.
    const reg = (await getReg(registrationId))!;
    expect(reg.status).toBe("checked_in");
    expect(reg.checkedInAt).not.toBeNull(); // IN intact
    expect(reg.checkedOutAt).toBeNull(); // OUT preview wrote nothing
    expect(reg.checkedOutByUserId).toBeNull();
    // No NEW ledger/audit rows beyond the real IN (preview added nothing).
    expect((await ledgerRowsOf(userId)).length).toBe(afterInLedger);
    expect((await auditRowsOf(registrationId)).length).toBe(afterInAudit);
    expect(await balanceOf(userId)).toBe(balanceAfterIn);
  });

  it("dry_run on a reject path (scan-OUT before any IN) → not_checked_in, still no mutation", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const baselineAudit = (await auditRowsOf(registrationId)).length; // registration audit only
    // OUT preview without a prior IN never reaches "ready" — it returns the reject code and writes nothing.
    const res = await dryScan(event.id, qrToken, staff.cookie, "out");
    expect((await res.json()) as { result: string }).toMatchObject({ result: "not_checked_in" });
    const reg = (await getReg(registrationId))!;
    expect(reg.checkedOutAt).toBeNull();
    expect((await ledgerRowsOf(userId)).length).toBe(0);
    // No scan audit added by the rejected preview (baseline registration audit unchanged).
    expect((await auditRowsOf(registrationId)).length).toBe(baselineAudit);
  });
});

// =====================================================================
// manual-checkout — mirrors the QR scan-OUT guard ladder, surfaced as
// thrown error codes. Stamps checkedOutAt + manual_checkout audit + awards
// checkin_out with scanMethod manual_search.
// =====================================================================

describe("checkins: manual check-out by registration id", () => {
  it("manual-checkout after an IN → checked_out_success, stamps + manual_checkout audit + awards checkin_out (manual_search)", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN +20

    const res = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; pointsAwarded: number; checkedOutAt: string };
    expect(body.result).toBe("checked_out_success");
    expect(body.pointsAwarded).toBe(20);
    expect(body.checkedOutAt).toBeTruthy();

    // Reg stamped checked-out by this staff; the IN (status checked_in) is untouched.
    const reg = (await getReg(registrationId))!;
    expect(reg.status).toBe("checked_in");
    expect(reg.checkedOutAt).not.toBeNull();
    expect(reg.checkedOutByUserId).toBe(staff.user.id);

    // checkin_out award carries scanMethod manual_search in metadata; balance == IN + OUT.
    expect(await balanceOf(userId)).toBe(40);
    expect(await ledgerSum(userId)).toBe(40);
    const [outEntry] = await db
      .select()
      .from(pointLedger)
      .where(and(eq(pointLedger.userId, userId), eq(pointLedger.reasonCode, "checkin_out")));
    expect((outEntry!.metadata as { scanMethod?: string }).scanMethod).toBe("manual_search");

    // manual_checkout audit row written.
    const audits = await auditRowsOf(registrationId);
    expect(audits.some((a) => a.action === "manual_checkout")).toBe(true);
  });

  it("manual-checkout before any IN → 400 not_checked_in", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const res = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_checked_in" });
  });

  it("manual-checkout twice → 400 already_checked_out (idempotent, no double award)", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN

    const first = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(first.status).toBe(200);
    expect(await balanceOf(userId)).toBe(40);

    const second = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(second.status).toBe(400);
    expect((await second.json()) as { error: string }).toMatchObject({ error: "already_checked_out" });
    expect(await balanceOf(userId)).toBe(40); // no second OUT award
    expect(await ledgerSum(userId)).toBe(40);
  });

  it("manual-checkout when checkinOutEnabled=false → 400 checkout_disabled", async () => {
    const event = await makeCheckinEvent();
    // Toggle defaults ON → disable explicitly to hit the gate (still set a window so only the toggle differs).
    await db.insert(eventPointConfig).values({ eventId: event.id, checkinOutEnabled: false });
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN

    const res = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "checkout_disabled" });
    expect((await getReg(registrationId))!.checkedOutAt).toBeNull();
  });

  it("manual-checkout past the points cutoff → 400 points_closed (no checkout stamp)", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN before cutoff

    await setPastCutoff();
    const res = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "points_closed" });
    expect((await getReg(registrationId))!.checkedOutAt).toBeNull();
  });

  it("manual-checkout when scan-out window is closed → 400 scan_window_closed", async () => {
    const event = await makeCheckinEvent();
    // Enabled but the window is in the PAST → window-closed reject (distinct from the toggle gate).
    const now = Date.now();
    await db.insert(eventPointConfig).values({
      eventId: event.id,
      checkinOutEnabled: true,
      scanOutOpenAt: new Date(now - 120 * 60 * 1000),
      scanOutCloseAt: new Date(now - 60 * 60 * 1000),
    });
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN

    const res = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: staff.cookie,
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "scan_window_closed" });
    expect((await getReg(registrationId))!.checkedOutAt).toBeNull();
  });

  it("student calling manual-checkout → 403", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { registrationId } = await registerStudent(event);
    const student = await loginAs("student");
    const res = await request(`/registrations/${registrationId}/manual-checkout`, {
      method: "POST",
      cookie: student.cookie,
    });
    expect(res.status).toBe(403);
  });
});

// =====================================================================
// undo-checkout — reverses ONLY the OUT leg (contrast with undo-checkin,
// which reverses BOTH). The IN stamp + IN points must survive.
// =====================================================================

describe("checkins: undo-checkout reverses ONLY the OUT leg", () => {
  it("after IN + OUT, undo-checkout nulls the OUT stamp, KEEPS the IN, reverses only OUT points", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await scan(event.id, qrToken, staff.cookie); // IN +20
    const out = await scan(event.id, qrToken, staff.cookie, "out"); // OUT +20
    expect((await out.json()) as { result: string }).toMatchObject({ result: "checked_out_success" });
    expect(await balanceOf(userId)).toBe(40);
    const inCheckedAt = (await getReg(registrationId))!.checkedInAt!.getTime();

    const undo = await request(`/registrations/${registrationId}/undo-checkout`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "scanned out by mistake" },
    });
    expect(undo.status).toBe(200);

    const reg = (await getReg(registrationId))!;
    // OUT stamp cleared, OUT actor cleared.
    expect(reg.checkedOutAt).toBeNull();
    expect(reg.checkedOutByUserId).toBeNull();
    // IN intact: status stays checked_in, checked_in_at unchanged.
    expect(reg.status).toBe("checked_in");
    expect(reg.checkedInAt).not.toBeNull();
    expect(reg.checkedInAt!.getTime()).toBe(inCheckedAt);

    // Only the OUT leg reversed: IN +20 survives → balance 20 (NOT 0, the undo-checkin distinction).
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20);
    // Exactly one correction_reverse, and it points at the checkin_out award (not the IN).
    const reversals = await db
      .select()
      .from(pointLedger)
      .where(and(eq(pointLedger.userId, userId), eq(pointLedger.reasonCode, "correction_reverse")));
    expect(reversals.length).toBe(1);
    expect(reversals[0]!.delta).toBe(-20);
    const [outAward] = await db
      .select()
      .from(pointLedger)
      .where(and(eq(pointLedger.userId, userId), eq(pointLedger.reasonCode, "checkin_out")));
    expect(reversals[0]!.reversalOfLedgerId).toBe(outAward!.id);
    // The IN award is NOT among the reversal targets (IN survival also proven by balance==20 above).
    const [inAward] = await db
      .select()
      .from(pointLedger)
      .where(and(eq(pointLedger.userId, userId), eq(pointLedger.reasonCode, "checkin_in")));
    expect(reversals.map((r) => r.reversalOfLedgerId)).not.toContain(inAward!.id);
    // manual_checkout_undo audit row written.
    const audits = await auditRowsOf(registrationId);
    expect(audits.some((a) => a.action === "manual_checkout_undo")).toBe(true);
  });

  it("undo-checkout when not checked out → 400 not_checked_out", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN only, never OUT

    const undo = await request(`/registrations/${registrationId}/undo-checkout`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "no checkout to undo" },
    });
    expect(undo.status).toBe(400);
    expect((await undo.json()) as { error: string }).toMatchObject({ error: "not_checked_out" });
  });

  it("CONTRAST: undo-checkIN reverses BOTH legs (→0); undo-checkOUT reverses only OUT (→20)", async () => {
    // undo-checkout (OUT-only) path.
    const evA = await makeCheckinEvent();
    await enableCheckout(evA.id);
    const a = await registerStudent(evA);
    const staff = await loginAs("checkin_staff");
    await scan(evA.id, a.qrToken, staff.cookie); // IN +20
    await scan(evA.id, a.qrToken, staff.cookie, "out"); // OUT +20
    await request(`/registrations/${a.registrationId}/undo-checkout`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "out only" },
    });
    expect(await balanceOf(a.userId)).toBe(20); // OUT-only reversal → IN survives

    // undo-checkin (both legs) path, fresh student/event for an isolated balance.
    const evB = await makeCheckinEvent();
    await enableCheckout(evB.id);
    const b = await registerStudent(evB);
    await scan(evB.id, b.qrToken, staff.cookie); // IN +20
    await scan(evB.id, b.qrToken, staff.cookie, "out"); // OUT +20
    await request(`/registrations/${b.registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "both legs" },
    });
    expect(await balanceOf(b.userId)).toBe(0); // undo-checkin reverses BOTH → 0
  });

  it("student calling undo-checkout → 403", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { registrationId } = await registerStudent(event);
    const student = await loginAs("student");
    const res = await request(`/registrations/${registrationId}/undo-checkout`, {
      method: "POST",
      cookie: student.cookie,
      body: { reason: "nope" },
    });
    expect(res.status).toBe(403);
  });
});
