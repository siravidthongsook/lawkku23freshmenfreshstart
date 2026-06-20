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

// POST a scan as a given staff/admin cookie.
function scan(eventId: string, qrToken: string, cookie?: string) {
  return request(`/events/${eventId}/checkins/scan`, {
    method: "POST",
    cookie,
    body: { qr_token: qrToken },
  });
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
