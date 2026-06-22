import { describe, it, expect } from "vitest";
import { eq, sql, and } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations } from "../src/db/schema/registrations";
import { users } from "../src/db/schema/users";
import { pointLedger } from "../src/db/schema/points";
import { auditLogs } from "../src/db/schema/audit";
import { eventPointConfig, pointSettings } from "../src/db/schema/point-config";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent } from "./helpers/factories";
import type { Event } from "../src/db/schema/events";

// ---- local helpers ----
async function makeCheckinEvent(opts: Parameters<typeof makeEvent>[0] = {}): Promise<Event> {
  const event = await makeEvent({ status: "published", ...opts });
  await db.insert(eventFormVersions).values({
    eventId: event.id,
    versionNumber: 1,
    schemaJson: { fields: [] },
    createdByAdminId: event.createdByAdminId,
    isActive: true,
  });
  return event;
}

// Register a real student → reg row + qr. Returns ids + cookie.
async function registerStudent(event: Event) {
  const { user, cookie } = await loginAs("student");
  const res = await request(`/events/${event.id}/register`, {
    method: "POST",
    cookie,
    body: { answers: {} },
  });
  if (res.status !== 201) throw new Error(`register expected 201, got ${res.status}: ${await res.text()}`);
  const body = (await res.json()) as { registration: { id: string }; qrToken: string | null };
  return { registrationId: body.registration.id, cookie, userId: user.id };
}

// POST the new admin state-override endpoint.
function stateOverride(
  registrationId: string,
  cookie: string,
  body: Record<string, unknown>,
) {
  return request(`/admin/registrations/${registrationId}/checkin-state`, {
    method: "POST",
    cookie,
    body,
  });
}

async function getReg(id: string) {
  const [r] = await db.select().from(registrations).where(eq(registrations.id, id));
  return r;
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
async function enableCheckout(eventId: string) {
  const now = Date.now();
  await db
    .insert(eventPointConfig)
    .values({
      eventId,
      checkinOutEnabled: true,
      scanOutOpenAt: new Date(now - 3_600_000),
      scanOutCloseAt: new Date(now + 86_400_000),
    })
    .onConflictDoUpdate({
      target: eventPointConfig.eventId,
      set: { checkinOutEnabled: true },
    });
}
async function disableCheckout(eventId: string) {
  await db
    .insert(eventPointConfig)
    .values({ eventId, checkinOutEnabled: false })
    .onConflictDoUpdate({ target: eventPointConfig.eventId, set: { checkinOutEnabled: false } });
}
async function setCutoffPast() {
  const past = new Date(Date.now() - 60_000);
  await db
    .insert(pointSettings)
    .values({ id: 1, cutoffAt: past })
    .onConflictDoUpdate({ target: pointSettings.id, set: { cutoffAt: past } });
}

// =====================================================================
// SET CHECK-IN (backdated)
// =====================================================================
describe("admin state-override: set check-in", () => {
  it("backdated check-in stores the exact UTC instant (no off-by-7h) + awards points", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");

    // 2026-06-20 14:30 Bangkok = 07:30Z. Frontend converts; backend gets UTC ISO.
    const utcIso = "2026-06-20T07:30:00.000Z";
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: utcIso },
      reason: "manual backdate",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkedInAt: string; points_skipped: string[] };
    expect(body.checkedInAt).toBe(utcIso);
    expect(body.points_skipped).toEqual([]);

    const reg = await getReg(registrationId);
    expect(reg!.status).toBe("checked_in");
    expect(reg!.checkedInAt!.toISOString()).toBe(utcIso);
    expect(reg!.checkinMethod).toBe("admin_override");
    expect(reg!.manualCheckinReason).toBe("manual backdate");
    expect(await balanceOf(userId)).toBe(20);
    expect(await ledgerSum(userId)).toBe(20);
  });

  it("set check-in without `at` defaults to now()", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set" },
      reason: "now",
    });
    expect(res.status).toBe(200);
    const reg = await getReg(registrationId);
    expect(reg!.checkedInAt).not.toBeNull();
  });

  it("awardPoints:false → stamp commits, no points", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", awardPoints: false },
      reason: "no credit",
    });
    expect(res.status).toBe(200);
    expect((await getReg(registrationId))!.status).toBe("checked_in");
    expect(await balanceOf(userId)).toBe(0);
  });
});

// =====================================================================
// SET CHECK-OUT
// =====================================================================
describe("admin state-override: set check-out", () => {
  it("set checkout on a checked-in reg stamps + awards checkin_out", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");

    // check in first, then out, in one combined request
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: "2026-06-20T07:00:00.000Z" },
      checkout: { action: "set", at: "2026-06-20T09:00:00.000Z" },
      reason: "both",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkedOutAt: string; points_skipped: string[] };
    expect(body.checkedOutAt).toBe("2026-06-20T09:00:00.000Z");
    expect(body.points_skipped).toEqual([]);
    const reg = await getReg(registrationId);
    expect(reg!.checkedOutAt!.toISOString()).toBe("2026-06-20T09:00:00.000Z");
    expect(await balanceOf(userId)).toBe(40); // 20 in + 20 out
  });
});

// =====================================================================
// CLEAR CHECK-IN — cascade checkout clear + single reverse of both legs
// =====================================================================
describe("admin state-override: clear check-in", () => {
  it("clears checkin + cascades checkout, reverses BOTH legs ONCE (balance back to 0, not double)", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");

    // Establish a full in+out state with points.
    await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: "2026-06-20T07:00:00.000Z" },
      checkout: { action: "set", at: "2026-06-20T09:00:00.000Z" },
      reason: "setup",
    });
    expect(await balanceOf(userId)).toBe(40);

    // Now clear the check-in → cascades checkout clear, reverses both legs ONCE.
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "clear" },
      reason: "mistake",
    });
    expect(res.status).toBe(200);
    const reg = await getReg(registrationId);
    expect(reg!.status).toBe("registered");
    expect(reg!.checkedInAt).toBeNull();
    expect(reg!.checkedOutAt).toBeNull(); // cascade
    expect(reg!.checkinMethod).toBeNull(); // [E12]
    // Balance back to 0 — NOT double-reversed (would be -40 → -40 if both reverse fns ran on OUT).
    expect(await balanceOf(userId)).toBe(0);
    expect(await ledgerSum(userId)).toBe(0);
  });

  it("clear check-in wipes manualCheckinReason + checkinMethod, records the clear reason", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");
    await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set" },
      reason: "in",
    });
    await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "clear" },
      reason: "wipe it",
    });
    const reg = await getReg(registrationId);
    expect(reg!.checkinMethod).toBeNull();
    expect(reg!.manualCheckinReason).toBe("wipe it"); // clear records WHY
  });
});

// =====================================================================
// CLEAR CHECK-OUT only — reverses only OUT leg
// =====================================================================
describe("admin state-override: clear check-out only", () => {
  it("clears checkout stamp + reverses only the OUT leg (check-in points stay)", async () => {
    const event = await makeCheckinEvent();
    await enableCheckout(event.id);
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");
    await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: "2026-06-20T07:00:00.000Z" },
      checkout: { action: "set", at: "2026-06-20T09:00:00.000Z" },
      reason: "setup",
    });
    expect(await balanceOf(userId)).toBe(40);

    const res = await stateOverride(registrationId, admin.cookie, {
      checkout: { action: "clear" },
      reason: "out mistake",
    });
    expect(res.status).toBe(200);
    const reg = await getReg(registrationId);
    expect(reg!.checkedInAt).not.toBeNull(); // check-in preserved
    expect(reg!.checkedOutAt).toBeNull();
    expect(await balanceOf(userId)).toBe(20); // only OUT reversed
  });
});

// =====================================================================
// CUTOFF + TOGGLE: stamp commits, points NOT awarded, warning returned
// =====================================================================
describe("admin state-override: points self-guard surfaces warning", () => {
  it("past cutoff → check-in stamp commits but points skipped + warning [E1]", async () => {
    const event = await makeCheckinEvent();
    await setCutoffPast();
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set" },
      reason: "after cutoff",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { points_skipped: string[] };
    expect((await getReg(registrationId))!.status).toBe("checked_in"); // stamp committed
    expect(await balanceOf(userId)).toBe(0); // no points
    expect(body.points_skipped).toContain("checkin_in:points_closed");
  });

  it("checkout toggle off → checkout stamp commits but points skipped + warning [E2]", async () => {
    const event = await makeCheckinEvent();
    await disableCheckout(event.id);
    const { registrationId, userId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: "2026-06-20T07:00:00.000Z" },
      checkout: { action: "set", at: "2026-06-20T09:00:00.000Z" },
      reason: "toggle off",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { points_skipped: string[] };
    expect((await getReg(registrationId))!.checkedOutAt).not.toBeNull(); // committed
    expect(await balanceOf(userId)).toBe(20); // only IN awarded (checkout disabled)
    expect(body.points_skipped).toContain("checkin_out:checkin_out_disabled");
  });
});

// =====================================================================
// REJECT invariants
// =====================================================================
describe("admin state-override: invariant rejects", () => {
  it("set check-in on a cancelled reg → checkin_blocked_status [E5]", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    await db.update(registrations).set({ status: "cancelled" }).where(eq(registrations.id, registrationId));
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set" },
      reason: "resurrect",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "checkin_blocked_status" });
  });

  it("set check-in on a waitlisted reg → checkin_blocked_status [E5]", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    await db.update(registrations).set({ status: "waitlisted" }).where(eq(registrations.id, registrationId));
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set" },
      reason: "x",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "checkin_blocked_status" });
  });

  it("set checkout without a check-in → checkout_without_checkin [E6]", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkout: { action: "set" },
      reason: "x",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "checkout_without_checkin" });
  });

  it("checkout earlier than check-in (post-op) → checkout_before_checkin [E6]", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: "2026-06-20T09:00:00.000Z" },
      checkout: { action: "set", at: "2026-06-20T07:00:00.000Z" }, // before in
      reason: "x",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "checkout_before_checkin" });
  });

  it("future `at` → at_in_future [E8]", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const res = await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: future },
      reason: "x",
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "at_in_future" });
  });

  it("both axes unchanged → no_changes [E14]", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");
    const res = await stateOverride(registrationId, admin.cookie, { reason: "nothing" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_changes" });
  });
});

// =====================================================================
// AUDIT + provenance + qr_scan no-double-award + authz
// =====================================================================
describe("admin state-override: audit, provenance, dedupe, authz", () => {
  it("writes an audit row with old checkinMethod provenance + reason [E13]", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const admin = await loginAs("admin");
    // First set check-in (records admin_override method), then edit time again.
    await stateOverride(registrationId, admin.cookie, { checkin: { action: "set" }, reason: "first" });
    await stateOverride(registrationId, admin.cookie, {
      checkin: { action: "set", at: "2026-06-20T07:00:00.000Z" },
      reason: "retime",
    });
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.registrationId, registrationId), eq(auditLogs.action, "admin_checkin_state_edit")))
      .orderBy(sql`${auditLogs.createdAt} desc`)
      .limit(1);
    expect(row!.action).toBe("admin_checkin_state_edit");
    expect(row!.reason).toBe("retime");
    expect((row!.oldValue as { checkinMethod: string | null }).checkinMethod).toBe("admin_override");
  });

  it("editing a qr_scan check-in time does NOT double-award (dedupe) [E4]", async () => {
    const event = await makeCheckinEvent({
      checkinOpenAt: new Date(Date.now() - 3_600_000),
      checkinCloseAt: new Date(Date.now() + 3_600_000),
    });
    const { user, cookie } = await loginAs("student");
    const reg = await request(`/events/${event.id}/register`, { method: "POST", cookie, body: { answers: {} } });
    const regBody = (await reg.json()) as { registration: { id: string }; qrToken: string };
    const staff = await loginAs("checkin_staff");
    // Real QR scan → checkin_in awarded (20), method qr_scan.
    await request(`/events/${event.id}/checkins/scan`, {
      method: "POST",
      cookie: staff.cookie,
      body: { qr_token: regBody.qrToken },
    });
    expect(await balanceOf(user.id)).toBe(20);

    // Admin retimes the same check-in — must NOT re-award (same epoch dedupeKey).
    const admin = await loginAs("admin");
    const res = await stateOverride(regBody.registration.id, admin.cookie, {
      checkin: { action: "set", at: "2026-06-20T07:00:00.000Z" },
      reason: "retime qr",
    });
    expect(res.status).toBe(200);
    expect(await balanceOf(user.id)).toBe(20); // still 20, not 40
    expect((await getReg(regBody.registration.id))!.checkinMethod).toBe("admin_override");
  });

  it("non-admin staff → 403", async () => {
    const event = await makeCheckinEvent();
    const { registrationId } = await registerStudent(event);
    const staff = await loginAs("checkin_staff");
    const res = await stateOverride(registrationId, staff.cookie, {
      checkin: { action: "set" },
      reason: "x",
    });
    expect(res.status).toBe(403);
  });

  it("student → 403", async () => {
    const event = await makeCheckinEvent();
    const { registrationId, cookie } = await registerStudent(event);
    const res = await stateOverride(registrationId, cookie, {
      checkin: { action: "set" },
      reason: "x",
    });
    expect(res.status).toBe(403);
  });
});
