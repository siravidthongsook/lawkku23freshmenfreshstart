import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointLedger, staffBudgetLedger } from "../src/db/schema/points";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// ---- helpers ----
async function budgetOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.staffPointBudget }).from(users).where(eq(users.id, userId));
  return u!.b;
}
async function budgetLedgerCount(userId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(staffBudgetLedger)
    .where(eq(staffBudgetLedger.staffUserId, userId));
  return r!.c;
}
async function topup(adminCookie: string, staffId: string, amount: number) {
  return request(`/admin/staff/${staffId}/point-budget/topup`, {
    method: "POST",
    cookie: adminCookie,
    body: { amount, reason: "alloc" },
  });
}
// Latest ledger entry of any reason for a student (the one just created).
async function latestLedger(userId: string) {
  const [row] = await db
    .select()
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId))
    .orderBy(sql`${pointLedger.createdAt} DESC`)
    .limit(1);
  return row;
}

// =====================================================================
// BUG 1 — only checkin_staff may hold a grant budget (not_staff)
// =====================================================================
describe("budget topup: only checkin_staff can be topped up (not_staff guard)", () => {
  it("topup to a STUDENT is rejected; budget unchanged + no ledger row", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");

    const res = await topup(admin.cookie, student.user.id, 50);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_staff" });
    expect(await budgetOf(student.user.id)).toBe(0);
    expect(await budgetLedgerCount(student.user.id)).toBe(0);
  });

  it("topup to another ADMIN is rejected; budget unchanged + no ledger row", async () => {
    const admin = await loginAs("admin");
    const other = await loginAs("admin");

    const res = await topup(admin.cookie, other.user.id, 50);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_staff" });
    expect(await budgetOf(other.user.id)).toBe(0);
    expect(await budgetLedgerCount(other.user.id)).toBe(0);
  });

  it("signed adjust to a STUDENT is rejected with not_staff", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");
    const res = await request(`/admin/staff/${student.user.id}/point-budget/adjust`, {
      method: "POST",
      cookie: admin.cookie,
      body: { delta: 20, reason: "x" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_staff" });
    expect(await budgetOf(student.user.id)).toBe(0);
  });

  it("checkin_staff topup still works (control)", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    const res = await topup(admin.cookie, staff.user.id, 50);
    expect(res.status).toBe(200);
    expect(await budgetOf(staff.user.id)).toBe(50);
  });
});

describe("bulk topup: one non-staff id rejects the WHOLE tx", () => {
  it("mixed list (staff + one student) is fully rejected; no one is topped up", async () => {
    const admin = await loginAs("admin");
    const staffA = await loginAs("checkin_staff");
    const staffB = await loginAs("checkin_staff");
    const student = await loginAs("student");

    const res = await request("/admin/staff/point-budget/topup-bulk", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_ids: [staffA.user.id, student.user.id, staffB.user.id], amount: 25, reason: "bulk" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_staff" });
    // whole tx rolled back → nobody, including the valid staff before the student, got budget
    expect(await budgetOf(staffA.user.id)).toBe(0);
    expect(await budgetOf(staffB.user.id)).toBe(0);
    expect(await budgetOf(student.user.id)).toBe(0);
    expect(await budgetLedgerCount(staffA.user.id)).toBe(0);
  });

  it("all-staff bulk list still applies to everyone (control)", async () => {
    const admin = await loginAs("admin");
    const staffA = await loginAs("checkin_staff");
    const staffB = await loginAs("checkin_staff");
    const res = await request("/admin/staff/point-budget/topup-bulk", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_ids: [staffA.user.id, staffB.user.id], amount: 25, reason: "bulk" },
    });
    expect(res.status).toBe(200);
    expect(await budgetOf(staffA.user.id)).toBe(25);
    expect(await budgetOf(staffB.user.id)).toBe(25);
  });
});

// =====================================================================
// BUG 2 — admin reverse may only reverse an EARNING entry (not_reversible)
// =====================================================================
describe("admin reverse: cannot reverse a correction_reverse / correction_add row", () => {
  async function reverse(adminCookie: string, userId: string, ledgerId: string) {
    return request(`/admin/users/${userId}/points/reverse`, {
      method: "POST",
      cookie: adminCookie,
      body: { ledger_id: ledgerId, reason: "dispute" },
    });
  }

  it("reverse a manual_adjust (ok), then reversing the resulting correction_reverse is rejected", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");

    // earning entry: admin manual give
    const give = await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.user.id, delta: 30, reason: "bonus" },
    });
    expect(give.status).toBe(200);
    const original = (await latestLedger(student.user.id))!;
    expect(original.reasonCode).toBe("manual_adjust");

    // first reverse → ok, creates a correction_reverse row
    const r1 = await reverse(admin.cookie, student.user.id, original.id);
    expect(r1.status).toBe(200);
    const reverseRow = (await latestLedger(student.user.id))!;
    expect(reverseRow.reasonCode).toBe("correction_reverse");

    // reversing that correction_reverse row → not_reversible (no re-credit chain)
    const r2 = await reverse(admin.cookie, student.user.id, reverseRow.id);
    expect(r2.status).toBe(400);
    expect((await r2.json()) as { result: string }).toMatchObject({ result: "not_reversible" });
  });

  it("reversing a correction_add row is rejected with not_reversible", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");

    const correct = await request(`/admin/users/${student.user.id}/points/correct`, {
      method: "POST",
      cookie: admin.cookie,
      body: { delta: 15, reason: "missed award" },
    });
    expect(correct.status).toBe(200);
    const addRow = (await latestLedger(student.user.id))!;
    expect(addRow.reasonCode).toBe("correction_add");

    const r = await reverse(admin.cookie, student.user.id, addRow.id);
    expect(r.status).toBe(400);
    expect((await r.json()) as { result: string }).toMatchObject({ result: "not_reversible" });
  });
});

// =====================================================================
// BUG 3 — grant cost overflow → clean 400, not 500
// =====================================================================
describe("grant issue: points_value × max_claims is capped (no int4 overflow → 500)", () => {
  it("100000 × 100000 (= 1e10) is rejected with 400 validation, not 500", async () => {
    const staff = await loginAs("checkin_staff");
    const res = await request("/points/grant-tokens", {
      method: "POST",
      cookie: staff.cookie,
      body: { points_value: 100000, max_claims: 100000 },
    });
    // zValidator rejects the body before the handler → clean 400 (not a Postgres int4 overflow → 500).
    expect(res.status).toBe(400);
  });

  it("a large-but-fitting grant (within budget + cap) still works", async () => {
    const admin = await loginAs("admin");
    const staff = await loginAs("checkin_staff");
    // cost = 1000 × 1000 = 1_000_000 (under the 10M cap and fits int4); fund it first.
    const t = await topup(admin.cookie, staff.user.id, 1_000_000);
    expect(t.status).toBe(200);
    const res = await request("/points/grant-tokens", {
      method: "POST",
      cookie: staff.cookie,
      body: { points_value: 1000, max_claims: 1000 },
    });
    expect(res.status).toBe(201);
    expect(await budgetOf(staff.user.id)).toBe(0); // fully spent
  });
});
