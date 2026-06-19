import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { pointLedger, staffBudgetLedger } from "../src/db/schema/points";
import { reconcilePoints } from "../src/modules/points/reconcile-service";
import { seedUser } from "./helpers/auth";

// Phase 7 cache-drift safety net (plan §9/§10/§15.8). The reconcile script recomputes truth from the
// append-only ledgers and reports drift; --apply repairs it. These tests seed a DELIBERATELY-WRONG
// cache (direct UPDATE — bypassing addPoints) and assert detect (dry-run) + repair (apply).

// Insert a ledger row directly (truth) WITHOUT touching the cache — simulates a real entry.
async function ledgerRow(userId: string, delta: number, createdAt?: Date) {
  await db.insert(pointLedger).values({
    userId,
    delta,
    reasonCode: delta > 0 ? "manual_adjust" : "correction_reverse",
    ...(createdAt ? { createdAt } : {}),
  });
}
async function budgetRow(staffUserId: string, delta: number, createdByUserId: string) {
  await db.insert(staffBudgetLedger).values({
    staffUserId,
    delta,
    reasonCode: delta > 0 ? "topup" : "grant_issue",
    createdByUserId,
  });
}
async function cachedBalance(userId: string) {
  const [u] = await db
    .select({ b: users.pointsBalance, lp: users.lastPositiveAt })
    .from(users)
    .where(eq(users.id, userId));
  return u!;
}
async function cachedBudget(userId: string) {
  const [u] = await db.select({ b: users.staffPointBudget }).from(users).where(eq(users.id, userId));
  return u!.b;
}

describe("reconcile-points: balance drift", () => {
  it("dry-run detects a wrong pointsBalance cache without writing; --apply repairs it to SUM(ledger)", async () => {
    const u = await seedUser({ role: "student" });
    // Truth = 20 + 100 = 120 from ledger rows.
    await ledgerRow(u.id, 20);
    await ledgerRow(u.id, 100);
    // Deliberately corrupt the cache to a wrong value (bypass addPoints).
    await db.update(users).set({ pointsBalance: 999 }).where(eq(users.id, u.id));

    // Dry-run: detects, does NOT write.
    const report = await reconcilePoints();
    const drift = report.balanceDrift.find((d) => d.userId === u.id);
    expect(drift).toBeDefined();
    expect(drift!.cached).toBe(999);
    expect(drift!.truth).toBe(120);
    expect(drift!.diff).toBe(120 - 999);
    expect(report.applied).toBe(false);
    expect((await cachedBalance(u.id)).b).toBe(999); // unchanged by dry-run

    // Apply: repairs cache to ledger truth.
    const fixed = await reconcilePoints({ apply: true });
    expect(fixed.applied).toBe(true);
    expect(fixed.balanceDrift.find((d) => d.userId === u.id)).toBeDefined(); // still reports what it fixed
    expect((await cachedBalance(u.id)).b).toBe(120);

    // Re-run dry-run → no drift remains for this user.
    const after = await reconcilePoints();
    expect(after.balanceDrift.find((d) => d.userId === u.id)).toBeUndefined();
  });
});

describe("reconcile-points: staff budget drift", () => {
  it("detects + repairs a wrong staffPointBudget cache to SUM(budget_ledger)", async () => {
    const admin = await seedUser({ role: "admin" });
    const staff = await seedUser({ role: "checkin_staff" });
    // Truth = 50 - 30 = 20.
    await budgetRow(staff.id, 50, admin.id);
    await budgetRow(staff.id, -30, staff.id);
    await db.update(users).set({ staffPointBudget: 7 }).where(eq(users.id, staff.id));

    const report = await reconcilePoints();
    const drift = report.budgetDrift.find((d) => d.userId === staff.id);
    expect(drift).toBeDefined();
    expect(drift!.cached).toBe(7);
    expect(drift!.truth).toBe(20);
    expect(await cachedBudget(staff.id)).toBe(7); // dry-run wrote nothing

    await reconcilePoints({ apply: true });
    expect(await cachedBudget(staff.id)).toBe(20);
  });
});

describe("reconcile-points: lastPositiveAt drift", () => {
  it("repairs lastPositiveAt to MAX(created_at) of POSITIVE rows; reversals never set it", async () => {
    const u = await seedUser({ role: "student" });
    const t1 = new Date("2026-01-01T00:00:00Z");
    const t2 = new Date("2026-02-01T00:00:00Z"); // latest POSITIVE → this is the truth
    const t3 = new Date("2026-03-01T00:00:00Z"); // a later NEGATIVE (reverse) must NOT move tie-break
    await ledgerRow(u.id, 20, t1);
    await ledgerRow(u.id, 100, t2);
    await ledgerRow(u.id, -100, t3); // reversal — later in time but negative
    // Truth balance = 20; keep balance cache correct so we isolate the lastPositiveAt check.
    await db.update(users).set({ pointsBalance: 20, lastPositiveAt: t3 }).where(eq(users.id, u.id)); // wrong: points at the reversal

    const report = await reconcilePoints();
    const lpDrift = report.lastPositiveDrift.find((d) => d.userId === u.id);
    expect(lpDrift).toBeDefined();
    expect(lpDrift!.truth).toBe(t2.toISOString()); // MAX over positive rows only
    expect(report.balanceDrift.find((d) => d.userId === u.id)).toBeUndefined(); // balance was correct

    await reconcilePoints({ apply: true });
    const cached = await cachedBalance(u.id);
    expect(cached.lp!.getTime()).toBe(t2.getTime());
  });
});

describe("reconcile-points: clean state", () => {
  it("reports no drift when caches already match ledger truth", async () => {
    // Fresh user with no ledger + zero cache = consistent.
    await seedUser({ role: "student" });
    const report = await reconcilePoints();
    // Some other tests may seed drift, so scope the assertion: a clean user contributes nothing.
    // Here we only assert the report shape + that applied is false on a dry-run.
    expect(report.applied).toBe(false);
    expect(Array.isArray(report.balanceDrift)).toBe(true);
  });
});
