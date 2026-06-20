import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations } from "../src/db/schema/registrations";
import { users } from "../src/db/schema/users";
import { pointLedger } from "../src/db/schema/points";
import { eventPointConfig, pointSettings } from "../src/db/schema/point-config";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent } from "./helpers/factories";
import type { Event } from "../src/db/schema/events";

// ---- local helpers (mirror checkins.test.ts scan path) ----
async function makeFormVersion(event: Event): Promise<void> {
  await db.insert(eventFormVersions).values({
    eventId: event.id,
    versionNumber: 1,
    schemaJson: { fields: [] },
    createdByAdminId: event.createdByAdminId,
    isActive: true,
  });
}

async function makeCheckinEvent(opts: Parameters<typeof makeEvent>[0] = {}): Promise<Event> {
  const event = await makeEvent({ status: "published", ...opts });
  await makeFormVersion(event);
  return event;
}

async function registerStudent(event: Event) {
  const { user, cookie } = await loginAs("student");
  const res = await request(`/events/${event.id}/register`, {
    method: "POST",
    cookie,
    body: { answers: {} },
  });
  if (res.status !== 201) throw new Error(`register expected 201, got ${res.status}`);
  const body = (await res.json()) as { registration: { id: string }; qrToken: string | null };
  if (!body.qrToken) throw new Error("no qrToken returned");
  return { qrToken: body.qrToken, registrationId: body.registration.id, cookie, userId: user.id };
}

function scan(eventId: string, qrToken: string, cookie: string, scanType?: "in" | "out") {
  return request(`/events/${eventId}/checkins/scan`, {
    method: "POST",
    cookie,
    body: { qr_token: qrToken, ...(scanType ? { scan_type: scanType } : {}) },
  });
}

// Manual check-in by registration id (no QR) — the staff-search path. checkin_method = manual_search.
function manualCheckin(registrationId: string, cookie: string) {
  return request(`/registrations/${registrationId}/manual-checkin`, { method: "POST", cookie });
}

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

async function getReg(id: string) {
  const [r] = await db.select().from(registrations).where(eq(registrations.id, id));
  return r;
}

// Enable scan-out on an event by writing its point config row. Also sets an explicit scan-out window
// that's open NOW — scan-out only opens once anchored (event end or override), so without this the
// window is unresolved and OUT scans return scan_window_closed.
async function enableCheckout(eventId: string) {
  const now = Date.now();
  const scanOutOpenAt = new Date(now - 60 * 60 * 1000); // opened 1h ago
  const scanOutCloseAt = new Date(now + 24 * 60 * 60 * 1000); // closes in 24h
  await db
    .insert(eventPointConfig)
    .values({ eventId, checkinOutEnabled: true, scanOutOpenAt, scanOutCloseAt })
    .onConflictDoUpdate({
      target: eventPointConfig.eventId,
      set: { checkinOutEnabled: true, scanOutOpenAt, scanOutCloseAt },
    });
}

// Disable scan-out explicitly (toggle defaults ON) to test the checkout_disabled gate.
async function disableCheckout(eventId: string) {
  await db
    .insert(eventPointConfig)
    .values({ eventId, checkinOutEnabled: false })
    .onConflictDoUpdate({ target: eventPointConfig.eventId, set: { checkinOutEnabled: false } });
}

// =====================================================================
// Check-in IN award
// =====================================================================
describe("points: check-in IN awards default 20 (idempotent, balance == SUM(delta))", () => {
  it("scan IN awards 20 and surfaces pointsAwarded", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const res = await scan(event.id, qrToken, staff.cookie);
    const body = (await res.json()) as { result: string; pointsAwarded: number };
    expect(body.result).toBe("checked_in_success");
    expect(body.pointsAwarded).toBe(20);
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20); // cache == truth
  });

  it("rescan does NOT double-award (dedupeKey checkin_in:<regId>)", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await scan(event.id, qrToken, staff.cookie);
    const second = await scan(event.id, qrToken, staff.cookie);
    const body = (await second.json()) as { result: string };
    expect(body.result).toBe("already_checked_in");
    expect(await balanceOf(userId)).toBe(20); // still 20, no second credit
    expect(await ledgerSum(userId)).toBe(20);
  });

  it("per-event override beats the global default", async () => {
    const event = await makeCheckinEvent();
    await db.insert(eventPointConfig).values({ eventId: event.id, checkinInPoints: 50 });
    const { qrToken, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie);
    expect(await balanceOf(userId)).toBe(50);
  });

  it("checkinInEnabled=false → checks in but awards 0", async () => {
    const event = await makeCheckinEvent();
    await db.insert(eventPointConfig).values({ eventId: event.id, checkinInEnabled: false });
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "checked_in_success" });
    expect((await getReg(registrationId))!.status).toBe("checked_in"); // still checked in
    expect(await balanceOf(userId)).toBe(0); // but no points
  });
});

// =====================================================================
// Manual check-in IN award — regression for the bug where manual_search
// flipped status but never awarded checkin_in points (only QR scan did).
// =====================================================================
describe("points: manual check-in awards checkin_in like the QR scan path", () => {
  it("manual check-in awards 20, surfaces pointsAwarded, balance == SUM(delta)", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const res = await manualCheckin(registrationId, staff.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: string; pointsAwarded: number };
    expect(body.result).toBe("checked_in_success");
    expect(body.pointsAwarded).toBe(20);
    expect((await getReg(registrationId))!.checkinMethod).toBe("manual_search");
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20); // cache == truth
  });

  it("ledger row records scanMethod=manual_search in metadata", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await manualCheckin(registrationId, staff.cookie);

    const [entry] = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.userId, userId));
    expect(entry!.reasonCode).toBe("checkin_in");
    expect((entry!.metadata as { scanMethod?: string }).scanMethod).toBe("manual_search");
  });

  it("re-manual-checkin → already_checked_in (400), no double award", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await manualCheckin(registrationId, staff.cookie);
    const second = await manualCheckin(registrationId, staff.cookie);
    expect(second.status).toBe(400);
    expect((await second.json()) as { error: string }).toMatchObject({ error: "already_checked_in" });
    expect(await balanceOf(userId)).toBe(20); // still 20
    expect(await ledgerSum(userId)).toBe(20);
  });

  it("dedupeKey is shared with QR: QR scan after manual does not re-award", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await manualCheckin(registrationId, staff.cookie); // +20 via manual
    const scanRes = await scan(event.id, qrToken, staff.cookie); // already checked in
    expect((await scanRes.json()) as { result: string }).toMatchObject({ result: "already_checked_in" });
    expect(await balanceOf(userId)).toBe(20); // checkin_in:<reg> already burned
  });

  it("checkinInEnabled=false → manual checks in but awards 0", async () => {
    const event = await makeCheckinEvent();
    await db.insert(eventPointConfig).values({ eventId: event.id, checkinInEnabled: false });
    const { registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const res = await manualCheckin(registrationId, staff.cookie);
    const body = (await res.json()) as { result: string; pointsAwarded: number };
    expect(body.result).toBe("checked_in_success");
    expect(body.pointsAwarded).toBe(0);
    expect((await getReg(registrationId))!.status).toBe("checked_in"); // still checked in
    expect(await balanceOf(userId)).toBe(0);
  });

  it("past cutoff → manual checks in but awards 0", async () => {
    const event = await makeCheckinEvent();
    await db
      .insert(pointSettings)
      .values({ id: 1, cutoffAt: new Date(Date.now() - 60_000) })
      .onConflictDoUpdate({ target: pointSettings.id, set: { cutoffAt: new Date(Date.now() - 60_000) } });
    const { registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    const res = await manualCheckin(registrationId, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "checked_in_success" });
    expect((await getReg(registrationId))!.status).toBe("checked_in");
    expect(await balanceOf(userId)).toBe(0);
  });

  it("manual IN (+20) then QR scan OUT (+20); undo reverses BOTH legs → 0", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await manualCheckin(registrationId, staff.cookie); // IN +20 (manual)
    const out = await scan(event.id, qrToken, staff.cookie, "out"); // OUT +20 (QR)
    expect((await out.json()) as { result: string }).toMatchObject({ result: "checked_out_success" });
    expect(await balanceOf(userId)).toBe(40);

    const undo = await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "wrong person" },
    });
    expect(undo.status).toBe(200);
    expect(await balanceOf(userId)).toBe(0); // both legs reversed
    expect(await ledgerSum(userId)).toBe(0);
  });
});

// =====================================================================
// Admin status-change into checked_in awards checkin_in (default on, opt-out)
// =====================================================================
function adminStatus(
  registrationId: string,
  cookie: string,
  body: { status: string; reason: string; awardPoints?: boolean },
) {
  return request(`/admin/registrations/${registrationId}/status`, { method: "POST", cookie, body });
}

describe("points: admin status-change into checked_in awards checkin_in by default", () => {
  it("status → checked_in (default) awards 20, one checkin_in row, balance == SUM(delta)", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");

    const res = await adminStatus(registrationId, admin.cookie, {
      status: "checked_in",
      reason: "manual entry",
    });
    expect(res.status).toBe(200);
    expect((await getReg(registrationId))!.status).toBe("checked_in");
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20);
    const ins = await db.select().from(pointLedger).where(eq(pointLedger.reasonCode, "checkin_in"));
    expect(ins.length).toBe(1);
    expect(ins[0]!.dedupeKey).toBe(`checkin_in:${registrationId}:v0`);
    // admin override is distinct from QR/manual in both the reg column and ledger metadata.
    expect((await getReg(registrationId))!.checkinMethod).toBe("admin_override");
    expect((ins[0]!.metadata as { scanMethod?: string }).scanMethod).toBe("admin_override");
  });

  it("status → checked_in with awardPoints:false → checks in but awards 0", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");

    const res = await adminStatus(registrationId, admin.cookie, {
      status: "checked_in",
      reason: "correction, no credit",
      awardPoints: false,
    });
    expect(res.status).toBe(200);
    expect((await getReg(registrationId))!.status).toBe("checked_in");
    expect(await balanceOf(userId)).toBe(0);
    expect(await ledgerSum(userId)).toBe(0);
  });

  it("leaving checked_in reverses the awarded points symmetrically → balance 0", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");

    await adminStatus(registrationId, admin.cookie, { status: "checked_in", reason: "in" }); // +20
    expect(await balanceOf(userId)).toBe(20);

    const back = await adminStatus(registrationId, admin.cookie, {
      status: "registered",
      reason: "leaving checked_in",
    });
    expect(back.status).toBe(200);
    expect(await balanceOf(userId)).toBe(0); // reversed
    expect(await ledgerSum(userId)).toBe(0);
    const reversals = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "correction_reverse"));
    expect(reversals.length).toBe(1);

    // Re-entering checked_in after the reverse re-awards via the next epoch (v1).
    const again = await adminStatus(registrationId, admin.cookie, {
      status: "checked_in",
      reason: "redo",
    });
    expect(again.status).toBe(200);
    expect(await balanceOf(userId)).toBe(20);
    const ins = await db.select().from(pointLedger).where(eq(pointLedger.reasonCode, "checkin_in"));
    expect(ins.map((r) => r.dedupeKey).sort()).toEqual([
      `checkin_in:${registrationId}:v0`,
      `checkin_in:${registrationId}:v1`,
    ]);
  });
});

// =====================================================================
// Cutoff freeze
// =====================================================================
describe("points: cutoff freeze blocks earning", () => {
  it("past cutoff → IN still checks in but awards 0", async () => {
    const event = await makeCheckinEvent();
    // Singleton row 1 with a past cutoff.
    await db
      .insert(pointSettings)
      .values({ id: 1, cutoffAt: new Date(Date.now() - 60_000) })
      .onConflictDoUpdate({ target: pointSettings.id, set: { cutoffAt: new Date(Date.now() - 60_000) } });
    const { qrToken, userId, registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const res = await scan(event.id, qrToken, staff.cookie);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "checked_in_success" });
    expect((await getReg(registrationId))!.status).toBe("checked_in");
    expect(await balanceOf(userId)).toBe(0);
  });
});

// =====================================================================
// Check-out OUT
// =====================================================================
describe("points: check-out OUT", () => {
  it("OUT respects the checkinOutEnabled toggle → checkout_disabled when off", async () => {
    const event = await makeCheckinEvent();
    await disableCheckout(event.id); // toggle defaults ON now → disable explicitly to test the gate
    const { qrToken } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN first
    const out = await scan(event.id, qrToken, staff.cookie, "out");
    expect((await out.json()) as { result: string }).toMatchObject({ result: "checkout_disabled" });
  });

  it("OUT before any IN → not_checked_in", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const out = await scan(event.id, qrToken, staff.cookie, "out");
    expect((await out.json()) as { result: string }).toMatchObject({ result: "not_checked_in" });
  });

  it("enabled OUT awards 20, stamps checkedOutAt, idempotent on rescan", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // IN → +20

    const out = await scan(event.id, qrToken, staff.cookie, "out");
    const body = (await out.json()) as { result: string; pointsAwarded: number; checkedOutAt: string };
    expect(body.result).toBe("checked_out_success");
    expect(body.pointsAwarded).toBe(20);
    expect(body.checkedOutAt).toBeTruthy();
    const reg = (await getReg(registrationId))!;
    expect(reg.checkedOutAt).not.toBeNull();
    expect(reg.checkedOutByUserId).toBe(staff.user.id);
    expect(await balanceOf(userId)).toBe(40); // 20 in + 20 out

    const again = await scan(event.id, qrToken, staff.cookie, "out");
    expect((await again.json()) as { result: string }).toMatchObject({ result: "already_checked_out" });
    expect(await balanceOf(userId)).toBe(40); // no double award
    expect(await ledgerSum(userId)).toBe(40);
  });
});

// =====================================================================
// Undo-checkin reverses points (U6)
// =====================================================================
describe("points: undo-checkin reverses the awarded points (U6)", () => {
  it("undo posts a negative reversal → balance back to 0, lastPositiveAt unchanged", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie);
    expect(await balanceOf(userId)).toBe(20);
    const [afterIn] = await db.select({ lp: users.lastPositiveAt }).from(users).where(eq(users.id, userId));
    const lpAfterIn = afterIn!.lp;

    const undo = await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "scanned wrong person" },
    });
    expect(undo.status).toBe(200);
    expect(await balanceOf(userId)).toBe(0); // +20 reversed
    expect(await ledgerSum(userId)).toBe(0);

    // The reversal must NOT move the tie-break field (M2).
    const [afterUndo] = await db.select({ lp: users.lastPositiveAt }).from(users).where(eq(users.id, userId));
    expect(afterUndo!.lp?.getTime() ?? null).toBe(lpAfterIn?.getTime() ?? null);

    // There is exactly one correction_reverse pointing at the original checkin_in entry.
    const reversals = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "correction_reverse"));
    expect(reversals.length).toBe(1);
    expect(reversals[0]!.delta).toBe(-20);
    expect(reversals[0]!.reversalOfLedgerId).not.toBeNull();
  });

  it("full cycle IN(+20)→OUT(+20)→undo reverses BOTH legs → balance 0, two correction_reverse, second undo no-op", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await scan(event.id, qrToken, staff.cookie); // IN +20
    await scan(event.id, qrToken, staff.cookie, "out"); // OUT +20
    expect(await balanceOf(userId)).toBe(40);

    // Capture the two original awards + tie-break field before undo.
    const origs = await db.select().from(pointLedger).where(eq(pointLedger.userId, userId));
    const origIn = origs.find((l) => l.reasonCode === "checkin_in")!;
    const origOut = origs.find((l) => l.reasonCode === "checkin_out")!;
    const [beforeUndo] = await db.select({ lp: users.lastPositiveAt }).from(users).where(eq(users.id, userId));
    const lpBeforeUndo = beforeUndo!.lp;

    const undo = await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "scanned wrong person" },
    });
    expect(undo.status).toBe(200);
    expect(await balanceOf(userId)).toBe(0); // both +20s reversed
    expect(await ledgerSum(userId)).toBe(0);

    // lastPositiveAt must be untouched by the negative reversals (M2).
    const [afterUndo] = await db.select({ lp: users.lastPositiveAt }).from(users).where(eq(users.id, userId));
    expect(afterUndo!.lp?.getTime() ?? null).toBe(lpBeforeUndo?.getTime() ?? null);

    // Exactly two reversals, one per original leg, each pointing at the right entry.
    const reversals = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "correction_reverse"));
    expect(reversals.length).toBe(2);
    expect(reversals.every((r) => r.delta === -20)).toBe(true);
    const reversedIds = reversals.map((r) => r.reversalOfLedgerId);
    expect(reversedIds).toContain(origIn.id);
    expect(reversedIds).toContain(origOut.id);

    // Second cycle: re-scan IN after undo RE-AWARDS via a fresh epoch key (checkin_in:<reg>:v1).
    // (OUT is not re-scanned here, so only the IN leg comes back: +20.)
    const reIn = await scan(event.id, qrToken, staff.cookie); // re-IN → fresh +20
    expect((await reIn.json()) as { result: string; pointsAwarded: number }).toMatchObject({
      result: "checked_in_success",
      pointsAwarded: 20,
    });
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20);

    // Undo again reverses the fresh IN award (the active v1 epoch) → balance back to 0, 3rd reversal.
    await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "second undo" },
    });
    expect(await balanceOf(userId)).toBe(0);
    expect(await ledgerSum(userId)).toBe(0);
    const reversalsAfter = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "correction_reverse"));
    expect(reversalsAfter.length).toBe(3); // two from the first undo + one for the re-awarded IN
  });

  it("re-check-in after undo RE-AWARDS via a fresh epoch key (bug fix); each undo reverses the active epoch", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // +20 (dedupeKey checkin_in:<reg>:v0)

    await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "first undo" },
    });
    expect(await balanceOf(userId)).toBe(0); // v0 reversed

    // Re-scan after undo: v0 is reversed → epoch bumps to v1 → fresh +20 (the legit "redo" path).
    const reIn = await scan(event.id, qrToken, staff.cookie);
    expect((await reIn.json()) as { pointsAwarded: number }).toMatchObject({ pointsAwarded: 20 });
    expect(await balanceOf(userId)).toBe(20);

    // Second undo: reverses the ACTIVE award (v1), not the already-reversed v0 → balance back to 0.
    await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "second undo" },
    });
    expect(await balanceOf(userId)).toBe(0);
    expect(await ledgerSum(userId)).toBe(0);
    const reversals = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "correction_reverse"));
    expect(reversals.length).toBe(2); // one per epoch (v0, v1)
    // Two distinct checkin_in awards exist (v0, v1), both now reversed.
    const ins = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "checkin_in"));
    expect(ins.length).toBe(2);
    expect(ins.map((r) => r.dedupeKey).sort()).toEqual([
      `checkin_in:${registrationId}:v0`,
      `checkin_in:${registrationId}:v1`,
    ]);
  });

  it("genuine double-scan WITHOUT undo stays idempotent (same epoch key, deduped)", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await scan(event.id, qrToken, staff.cookie); // +20 at v0
    await scan(event.id, qrToken, staff.cookie); // already_checked_in; no undo → still v0 → deduped
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20);
    const ins = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "checkin_in"));
    expect(ins.length).toBe(1); // exactly one award row, no second credit
    expect(ins[0]!.dedupeKey).toBe(`checkin_in:${registrationId}:v0`);
  });

  it("re-check-in after undo: scan IN→undo→re-scan IN → balance 20 (re-awarded), then double-scan stays 20", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await scan(event.id, qrToken, staff.cookie); // +20 (v0)
    await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "wrong person" },
    });
    const reIn = await scan(event.id, qrToken, staff.cookie); // re-IN → +20 (v1)
    const reBody = (await reIn.json()) as { result: string };
    expect(reBody.result).toBe("checked_in_success");
    expect((await getReg(registrationId))!.status).toBe("checked_in");
    expect(await balanceOf(userId)).toBe(20); // re-awarded

    // 2nd scan with NO undo in between → idempotent at v1, still 20.
    await scan(event.id, qrToken, staff.cookie);
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20);
  });

  it("two parallel re-scans after an undo → exactly one re-award (race-safe via reg row lock)", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");

    await scan(event.id, qrToken, staff.cookie); // +20 (v0)
    await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "undo before redo" },
    });
    expect(await balanceOf(userId)).toBe(0);

    // Fire two re-scans simultaneously on the connection pool: the reg FOR UPDATE lock serializes them,
    // so exactly ONE flips registered→checked_in and re-awards; the other sees already_checked_in.
    const [r1, r2] = await Promise.all([
      scan(event.id, qrToken, staff.cookie),
      scan(event.id, qrToken, staff.cookie),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    const outcomes = [
      (await r1.json()) as { result: string },
      (await r2.json()) as { result: string },
    ]
      .map((r) => r.result)
      .sort();
    expect(outcomes).toEqual(["already_checked_in", "checked_in_success"]);

    expect(await balanceOf(userId)).toBe(20); // exactly one +20
    expect(await ledgerSum(userId)).toBe(20); // cache == truth
    const insAfter = await db
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.reasonCode, "checkin_in"));
    expect(insAfter.length).toBe(2); // v0 + the single re-award v1 (no double)
  });
});
