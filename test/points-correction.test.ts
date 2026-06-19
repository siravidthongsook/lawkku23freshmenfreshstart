import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointLedger, staffBudgetLedger } from "../src/db/schema/points";
import { pointSettings } from "../src/db/schema/point-config";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

async function balanceOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.pointsBalance }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function budgetOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.staffPointBudget }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function ledgerSum(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${pointLedger.delta}),0)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  return r!.s;
}
async function budgetSum(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${staffBudgetLedger.delta}),0)::int` })
    .from(staffBudgetLedger)
    .where(eq(staffBudgetLedger.staffUserId, userId));
  return r!.s;
}
async function lastPositiveOf(userId: string): Promise<number | null> {
  const [u] = await db.select({ lp: users.lastPositiveAt }).from(users).where(eq(users.id, userId));
  return u!.lp?.getTime() ?? null;
}
async function topup(adminCookie: string, staffId: string, amount: number) {
  return request(`/admin/staff/${staffId}/point-budget/topup`, {
    method: "POST",
    cookie: adminCookie,
    body: { amount, reason: "alloc" },
  });
}
// Latest manual_adjust ledger entry for a student (the one a staff/admin just created).
async function latestManualAdjust(userId: string) {
  const [row] = await db
    .select()
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId))
    .orderBy(sql`${pointLedger.createdAt} DESC`)
    .limit(1);
  return row;
}

// =====================================================================
// Manual adjust (+/-) with required reason
// =====================================================================
describe("points manual adjust: reason required; staff +only from budget; admin unlimited", () => {
  it("missing reason is rejected by validation (400)", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");
    const res = await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.user.id, delta: 5 }, // no reason
    });
    expect(res.status).toBe(400);
  });

  it("admin can give and deduct unlimited (does not touch budget)", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");

    const add = await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.user.id, delta: 30, reason: "bonus" },
    });
    expect(add.status).toBe(200);
    expect(await balanceOf(student.user.id)).toBe(30);

    const sub = await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.user.id, delta: -10, reason: "correction" },
    });
    expect(sub.status).toBe(200);
    expect(await balanceOf(student.user.id)).toBe(20);
    expect(await ledgerSum(student.user.id)).toBe(20);
  });

  it("staff give debits budget; negative delta rejected; over-budget rejected", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    const student = await loginAs("student");
    await topup(admin.cookie, staff.user.id, 20);

    // negative not allowed for staff
    const neg = await request("/points/adjust", {
      method: "POST",
      cookie: staff.cookie,
      body: { user_id: student.user.id, delta: -5, reason: "x" },
    });
    expect((await neg.json()) as { result: string }).toMatchObject({ result: "staff_must_be_positive" });

    // give 15 → budget 20→5
    const give = await request("/points/adjust", {
      method: "POST",
      cookie: staff.cookie,
      body: { user_id: student.user.id, delta: 15, reason: "well done" },
    });
    expect(give.status).toBe(200);
    expect(await balanceOf(student.user.id)).toBe(15);
    expect(await budgetOf(staff.user.id)).toBe(5);

    // give 10 → exceeds remaining budget (5)
    const over = await request("/points/adjust", {
      method: "POST",
      cookie: staff.cookie,
      body: { user_id: student.user.id, delta: 10, reason: "more" },
    });
    expect((await over.json()) as { result: string }).toMatchObject({ result: "insufficient_budget" });
    expect(await budgetOf(staff.user.id)).toBe(5); // unchanged
    expect(await budgetSum(staff.user.id)).toBe(5);
  });
});

// Count ledger rows for a user — for "no entry written" assertions.
async function ledgerCount(userId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  return r!.c;
}

// =====================================================================
// Admin correct: target must be a student (audit nit #1 — source has the guard)
// =====================================================================
describe("points admin correct: rejects non-student targets (not_student, no ledger row)", () => {
  it("correcting a STAFF target returns not_student (400) and writes no ledger entry", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");

    const res = await request(`/admin/users/${staff.user.id}/points/correct`, {
      method: "POST",
      cookie: admin.cookie,
      body: { delta: 25, reason: "should be refused" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "not_student" });
    expect(await balanceOf(staff.user.id)).toBe(0);
    expect(await ledgerCount(staff.user.id)).toBe(0); // no entry written
  });

  it("correcting an ADMIN target returns not_student (400) and writes no ledger entry", async () => {
    const admin = await loginAs("admin");
    const otherAdmin = await loginAs("admin");

    const res = await request(`/admin/users/${otherAdmin.user.id}/points/correct`, {
      method: "POST",
      cookie: admin.cookie,
      body: { delta: 10, reason: "should be refused" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { result: string }).toMatchObject({ result: "not_student" });
    expect(await balanceOf(otherAdmin.user.id)).toBe(0);
    expect(await ledgerCount(otherAdmin.user.id)).toBe(0);
  });
});

// =====================================================================
// Admin reverse any entry (idempotent, lastPositiveAt unmoved, U1 budget gate)
// =====================================================================
describe("points admin reverse: reverses any entry once; lastPositiveAt unmoved", () => {
  it("admin reverses a manual_adjust → balance back, second reverse already_reversed", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");
    await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.user.id, delta: 40, reason: "award" },
    });
    expect(await balanceOf(student.user.id)).toBe(40);
    const lpBefore = await lastPositiveOf(student.user.id);
    const entry = (await latestManualAdjust(student.user.id))!;

    const rev = await request(`/admin/users/${student.user.id}/points/reverse`, {
      method: "POST",
      cookie: admin.cookie,
      body: { ledger_id: entry.id, reason: "wrong person" },
    });
    expect(rev.status).toBe(200);
    expect(await balanceOf(student.user.id)).toBe(0);
    // lastPositiveAt must NOT move on a reversal (M2).
    expect(await lastPositiveOf(student.user.id)).toBe(lpBefore);

    const rev2 = await request(`/admin/users/${student.user.id}/points/reverse`, {
      method: "POST",
      cookie: admin.cookie,
      body: { ledger_id: entry.id, reason: "again" },
    });
    expect((await rev2.json()) as { result: string }).toMatchObject({ result: "already_reversed" });
    expect(await balanceOf(student.user.id)).toBe(0);
    expect(await ledgerSum(student.user.id)).toBe(0);
  });

  it("U1: reversing a STAFF manual_grant refunds budget; reversing an ADMIN manual_adjust does NOT mint budget", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    const student = await loginAs("student");
    await topup(admin.cookie, staff.user.id, 30);

    // staff grant 20 (budget 30→10)
    await request("/points/adjust", {
      method: "POST",
      cookie: staff.cookie,
      body: { user_id: student.user.id, delta: 20, reason: "staff grant" },
    });
    const staffEntry = (await latestManualAdjust(student.user.id))!;
    expect(await budgetOf(staff.user.id)).toBe(10);

    // admin reverses the staff grant → budget refunded back to 30
    const rev = await request(`/admin/users/${student.user.id}/points/reverse`, {
      method: "POST",
      cookie: admin.cookie,
      body: { ledger_id: staffEntry.id, reason: "undo staff grant" },
    });
    expect((await rev.json()) as { budgetRefunded: number }).toMatchObject({ budgetRefunded: 20 });
    expect(await budgetOf(staff.user.id)).toBe(30);
    expect(await budgetSum(staff.user.id)).toBe(30);

    // admin grants 15 directly (does NOT touch any budget)
    await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.user.id, delta: 15, reason: "admin grant" },
    });
    const adminEntry = (await latestManualAdjust(student.user.id))!;
    const budgetBefore = await budgetOf(staff.user.id);

    // reversing the admin grant must NOT mint budget for any staff
    const rev2 = await request(`/admin/users/${student.user.id}/points/reverse`, {
      method: "POST",
      cookie: admin.cookie,
      body: { ledger_id: adminEntry.id, reason: "undo admin grant" },
    });
    expect((await rev2.json()) as { budgetRefunded: number }).toMatchObject({ budgetRefunded: 0 });
    expect(await budgetOf(staff.user.id)).toBe(budgetBefore);
  });
});

// =====================================================================
// Admin cutoff bypass (U5)
// =====================================================================
describe("points cutoff: blocks staff/admin earning but admin correction bypasses", () => {
  async function setCutoffPast() {
    const past = new Date(Date.now() - 60_000);
    await db
      .insert(pointSettings)
      .values({ id: 1, cutoffAt: past })
      .onConflictDoUpdate({ target: pointSettings.id, set: { cutoffAt: past } });
  }

  it("manual_adjust is blocked past cutoff, but admin correct/reverse still works", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");
    await setCutoffPast();

    const blocked = await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.user.id, delta: 10, reason: "late" },
    });
    expect((await blocked.json()) as { result: string }).toMatchObject({ result: "points_closed" });
    expect(await balanceOf(student.user.id)).toBe(0);

    // admin correction BYPASSES cutoff (U5)
    const correct = await request(`/admin/users/${student.user.id}/points/correct`, {
      method: "POST",
      cookie: admin.cookie,
      body: { delta: 25, reason: "dispute fix" },
    });
    expect(correct.status).toBe(200);
    expect(await balanceOf(student.user.id)).toBe(25);
    expect(await ledgerSum(student.user.id)).toBe(25);
  });
});

// =====================================================================
// Staff self-reverse window (§4.7)
// =====================================================================
describe("points staff self-reverse: within window OK + refunds budget; outside rejected; admin always", () => {
  it("staff reverses own recent grant within window → balance back + budget refunded", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    const student = await loginAs("student");
    await topup(admin.cookie, staff.user.id, 30);

    await request("/points/adjust", {
      method: "POST",
      cookie: staff.cookie,
      body: { user_id: student.user.id, delta: 20, reason: "grant" },
    });
    const entry = (await latestManualAdjust(student.user.id))!;
    expect(await budgetOf(staff.user.id)).toBe(10);
    const lpBefore = await lastPositiveOf(student.user.id);

    const rev = await request(`/points/grant/${entry.id}/reverse`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "wrong student" },
    });
    expect(rev.status).toBe(200);
    expect((await rev.json()) as { result: string; budgetRefunded: number }).toMatchObject({
      result: "reversed",
      budgetRefunded: 20,
    });
    expect(await balanceOf(student.user.id)).toBe(0);
    expect(await budgetOf(staff.user.id)).toBe(30); // refunded
    expect(await lastPositiveOf(student.user.id)).toBe(lpBefore); // M2
    expect(await ledgerSum(student.user.id)).toBe(0);
    expect(await budgetSum(staff.user.id)).toBe(30);
  });

  it("staff cannot reverse ANOTHER staff's grant (not_your_grant)", async () => {
    const admin = await loginAs("admin");
    const staffA = await loginAs("checkin_staff");
    const staffB = await loginAs("checkin_staff");
    const student = await loginAs("student");
    await topup(admin.cookie, staffA.user.id, 30);

    await request("/points/adjust", {
      method: "POST",
      cookie: staffA.cookie,
      body: { user_id: student.user.id, delta: 10, reason: "grant" },
    });
    const entry = (await latestManualAdjust(student.user.id))!;

    const rev = await request(`/points/grant/${entry.id}/reverse`, {
      method: "POST",
      cookie: staffB.cookie,
      body: { reason: "meddling" },
    });
    expect((await rev.json()) as { result: string }).toMatchObject({ result: "not_your_grant" });
    expect(await balanceOf(student.user.id)).toBe(10);
  });

  it("outside the window staff is rejected (reverse_window_expired) but admin can still reverse", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    const student = await loginAs("student");
    await topup(admin.cookie, staff.user.id, 30);

    // window = 0 disables the staff self-reverse feature entirely (proxy for "outside window").
    await db
      .insert(pointSettings)
      .values({ id: 1, staffReverseWindowMin: 0 })
      .onConflictDoUpdate({ target: pointSettings.id, set: { staffReverseWindowMin: 0 } });

    await request("/points/adjust", {
      method: "POST",
      cookie: staff.cookie,
      body: { user_id: student.user.id, delta: 10, reason: "grant" },
    });
    const entry = (await latestManualAdjust(student.user.id))!;

    const staffRev = await request(`/points/grant/${entry.id}/reverse`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "too late" },
    });
    expect((await staffRev.json()) as { result: string }).toMatchObject({
      result: "reverse_window_expired",
    });
    expect(await balanceOf(student.user.id)).toBe(10);

    // admin bypasses the window — same endpoint, admin role.
    const adminRev = await request(`/points/grant/${entry.id}/reverse`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "admin override" },
    });
    expect(adminRev.status).toBe(200);
    expect((await adminRev.json()) as { result: string }).toMatchObject({ result: "reversed" });
    expect(await balanceOf(student.user.id)).toBe(0);
    // budget refunded back to the staff issuer
    expect(await budgetOf(staff.user.id)).toBe(30);
  });
});
