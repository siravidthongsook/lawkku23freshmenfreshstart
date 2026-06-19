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

// Enable scan-out on an event by writing its point config row.
async function enableCheckout(eventId: string) {
  await db
    .insert(eventPointConfig)
    .values({ eventId, checkinOutEnabled: true })
    .onConflictDoUpdate({ target: eventPointConfig.eventId, set: { checkinOutEnabled: true } });
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
  it("OUT requires the checkinOutEnabled toggle → checkout_disabled by default", async () => {
    const event = await makeCheckinEvent();
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

    // Second undo cycle is a clean no-op: re-scan can't re-award (dedupeKeys burned), undo adds no reversals.
    await scan(event.id, qrToken, staff.cookie); // re-IN → deduped
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
    expect(reversalsAfter.length).toBe(2); // still just two, no extra
  });

  it("undo is idempotent on re-check-in/undo: a second undo cycle does not double-reverse", async () => {
    const event = await makeCheckinEvent();
    const { qrToken, registrationId, userId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    await scan(event.id, qrToken, staff.cookie); // +20 (dedupeKey checkin_in:<reg>)

    await request(`/registrations/${registrationId}/undo-checkin`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "first undo" },
    });
    expect(await balanceOf(userId)).toBe(0);

    // Re-scan: dedupeKey already used → no new award (still 0).
    await scan(event.id, qrToken, staff.cookie);
    expect(await balanceOf(userId)).toBe(0);

    // Second undo: original already reversed → no second reversal.
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
    expect(reversals.length).toBe(1); // still just one
  });
});
