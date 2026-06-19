import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointLedger, staffBudgetLedger } from "../src/db/schema/points";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// ---- balance / budget helpers ----
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

// Admin tops up a staff member's budget through the real endpoint.
async function topup(adminCookie: string, staffId: string, amount: number) {
  return request(`/admin/staff/${staffId}/point-budget/topup`, {
    method: "POST",
    cookie: adminCookie,
    body: { amount, reason: "event-day allocation" },
  });
}

// =====================================================================
// Budget topup
// =====================================================================
describe("points budget: admin topup increases staffPointBudget (cache == SUM(budget.delta))", () => {
  it("topup +50 raises budget and writes a topup ledger row", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");

    const res = await topup(admin.cookie, staff.user.id, 50);
    expect(res.status).toBe(200);
    expect((await res.json()) as { budget: number }).toMatchObject({ budget: 50 });
    expect(await budgetOf(staff.user.id)).toBe(50);
    expect(await budgetSum(staff.user.id)).toBe(50); // cache == truth
  });

  it("admin adjust rejects when it would push budget negative (would_go_negative)", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 10);

    const res = await request(`/admin/staff/${staff.user.id}/point-budget/adjust`, {
      method: "POST",
      cookie: admin.cookie,
      body: { delta: -50, reason: "fix overcount" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "would_go_negative" });
    expect(await budgetOf(staff.user.id)).toBe(10); // unchanged
  });
});

// =====================================================================
// Grant token issue (debits budget, can't overspend)
// =====================================================================
describe("points grant: issue debits budget; can't issue beyond budget", () => {
  it("issue 5×5 debits 25 from a 25 budget and returns plaintext token once", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 25);

    const res = await request("/points/grant-tokens", {
      method: "POST",
      cookie: staff.cookie,
      body: { points_value: 5, max_claims: 5 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { token: string; tokenId: string };
    expect(body.token).toBeTruthy(); // plaintext returned ONCE
    expect(body.tokenId).toBeTruthy();
    expect(await budgetOf(staff.user.id)).toBe(0); // 25 - 25
    expect(await budgetSum(staff.user.id)).toBe(0);
  });

  it("issuing beyond budget is rejected with insufficient_budget; budget untouched", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 10);

    const res = await request("/points/grant-tokens", {
      method: "POST",
      cookie: staff.cookie,
      body: { points_value: 5, max_claims: 5 }, // cost 25 > 10
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "insufficient_budget" });
    expect(await budgetOf(staff.user.id)).toBe(10);
  });
});

// =====================================================================
// Student claim (awards once, re-claim no double)
// =====================================================================
describe("points grant: student claim awards once, re-claim no double award", () => {
  async function issueToken(staffCookie: string, pointsValue: number, maxClaims: number) {
    const res = await request("/points/grant-tokens", {
      method: "POST",
      cookie: staffCookie,
      body: { points_value: pointsValue, max_claims: maxClaims },
    });
    return ((await res.json()) as { token: string; tokenId: string });
  }

  it("first claim awards points; re-claim by same student is already_claimed with no double", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { token } = await issueToken(staff.cookie, 10, 5);

    const student = await loginAs("student");
    const first = await request("/points/claim", { method: "POST", cookie: student.cookie, body: { token } });
    expect((await first.json()) as { result: string; pointsAwarded: number }).toMatchObject({
      result: "granted_success",
      pointsAwarded: 10,
    });
    expect(await balanceOf(student.user.id)).toBe(10);

    const second = await request("/points/claim", { method: "POST", cookie: student.cookie, body: { token } });
    expect((await second.json()) as { result: string }).toMatchObject({ result: "already_claimed" });
    expect(await balanceOf(student.user.id)).toBe(10); // no double
    expect(await ledgerSum(student.user.id)).toBe(10);
  });

  it("two different students each claim once → 2 seats used", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { token } = await issueToken(staff.cookie, 10, 5);

    const s1 = await loginAs("student");
    const s2 = await loginAs("student");
    await request("/points/claim", { method: "POST", cookie: s1.cookie, body: { token } });
    await request("/points/claim", { method: "POST", cookie: s2.cookie, body: { token } });
    expect(await balanceOf(s1.user.id)).toBe(10);
    expect(await balanceOf(s2.user.id)).toBe(10);
  });

  it("a non-student cannot claim (not_student, no balance)", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 50);
    const { token } = await issueToken(staff.cookie, 10, 5);

    const otherStaff = await loginAs("checkin_staff");
    const res = await request("/points/claim", { method: "POST", cookie: otherStaff.cookie, body: { token } });
    expect((await res.json()) as { result: string }).toMatchObject({ result: "not_student" });
  });
});

// =====================================================================
// Revoke → refund unclaimed seats (idempotent)
// =====================================================================
describe("points grant: revoke refunds unclaimed seats once", () => {
  it("issue 5×5, claim 2, revoke → refunds 3×5=15 back to staff budget; second revoke no-op", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    await topup(admin.cookie, staff.user.id, 25);
    const issue = await request("/points/grant-tokens", {
      method: "POST",
      cookie: staff.cookie,
      body: { points_value: 5, max_claims: 5 },
    });
    const { tokenId, token } = (await issue.json()) as { tokenId: string; token: string };
    expect(await budgetOf(staff.user.id)).toBe(0);

    const s1 = await loginAs("student");
    const s2 = await loginAs("student");
    await request("/points/claim", { method: "POST", cookie: s1.cookie, body: { token } });
    await request("/points/claim", { method: "POST", cookie: s2.cookie, body: { token } });

    const rev = await request(`/points/grant-tokens/${tokenId}/revoke`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "ran out of time" },
    });
    expect(rev.status).toBe(200);
    expect((await rev.json()) as { result: string; refunded: number }).toMatchObject({
      result: "revoked",
      refunded: 15, // 3 unclaimed × 5
    });
    expect(await budgetOf(staff.user.id)).toBe(15);

    // Second revoke is a no-op (no double refund).
    const rev2 = await request(`/points/grant-tokens/${tokenId}/revoke`, {
      method: "POST",
      cookie: staff.cookie,
      body: { reason: "again" },
    });
    expect((await rev2.json()) as { result: string }).toMatchObject({ result: "already_revoked" });
    expect(await budgetOf(staff.user.id)).toBe(15);
    expect(await budgetSum(staff.user.id)).toBe(15);
  });
});
