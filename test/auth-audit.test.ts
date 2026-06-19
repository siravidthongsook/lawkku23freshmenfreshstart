import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users, type User } from "../src/db/schema/users";
import { auditLogs } from "../src/db/schema/audit";
import { request } from "./helpers/db";
import { seedUser } from "./helpers/auth";

// Auth audit-trail suite. Guards two behaviors:
//   1. account_temporarily_locked is audited ONCE per lockout (transition edge), not on every
//      blocked retry — the bug that flooded the audit log with duplicate lockout rows.
//   2. login_succeeded is written on every successful sign-in (login AND claim) so the audit log
//      is the single source of truth for "who actually got in".
// EMAIL_MAX_FAILS = 5 in src/modules/auth/service.ts.

const EMAIL_MAX_FAILS = 5;
const STRONG_PW = "claim-password-123";
const IG = "@freshman.ig";

// Count audit rows for an action (optionally filtered by metadata.identifier).
async function auditCount(action: string, identifier?: string): Promise<number> {
  const where = identifier
    ? and(eq(auditLogs.action, action), sql`${auditLogs.metadata}->>'identifier' = ${identifier}`)
    : eq(auditLogs.action, action);
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(auditLogs).where(where);
  return row?.c ?? 0;
}

// Insert an unclaimed account (null hash) so the claim flow can set its first password.
async function seedUnclaimed(studentId: string): Promise<User> {
  const [row] = await db
    .insert(users)
    .values({
      email: null,
      role: "student",
      fullName: "Unclaimed Freshman",
      studentId,
      status: "active",
      passwordHash: null,
    })
    .returning();
  if (!row) throw new Error("seedUnclaimed: insert returned no row");
  return row;
}

describe("lockout audit fires once per lockout (no duplicate spam)", () => {
  it("logs account_temporarily_locked exactly once across many failed + blocked attempts", async () => {
    const user = await seedUser({ role: "admin", email: "lock-target@example.test" });

    // Hammer the login with wrong passwords well past the threshold. Attempts 1-4 fail without
    // locking; attempt 5 crosses the threshold (1 audit); 6+ are blocked at the gate (no re-audit).
    const TOTAL_ATTEMPTS = EMAIL_MAX_FAILS + 4; // 9 attempts → 4 extra blocked requests
    let saw429 = false;
    for (let i = 0; i < TOTAL_ATTEMPTS; i++) {
      const res = await request("/auth/login", {
        method: "POST",
        body: { identifier: user.email, password: "wrong-password-xx" },
      });
      if (res.status === 429) saw429 = true;
    }

    expect(saw429).toBe(true); // lockout actually engaged
    // The whole point: one lockout → one audit row, not one per blocked request.
    expect(await auditCount("account_temporarily_locked", user.email!)).toBe(1);
  });

  it("does not log a lockout before the threshold is reached", async () => {
    const user = await seedUser({ role: "admin", email: "under-threshold@example.test" });
    // One failure short of the threshold → no lockout audit yet.
    for (let i = 0; i < EMAIL_MAX_FAILS - 1; i++) {
      await request("/auth/login", {
        method: "POST",
        body: { identifier: user.email, password: "wrong-password-xx" },
      });
    }
    expect(await auditCount("account_temporarily_locked", user.email!)).toBe(0);
  });
});

describe("login_succeeded audit on every successful sign-in", () => {
  it("writes login_succeeded (method=login) on a successful password login", async () => {
    const admin = await seedUser({ role: "admin", email: "signin-login@example.test" });
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: admin.password },
    });
    expect(res.status).toBe(200);

    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "login_succeeded"));
    expect(row).toBeTruthy();
    expect(row!.targetUserId).toBe(admin.id);
    expect(row!.actorUserId).toBe(admin.id);
    expect((row!.metadata as { method?: string }).method).toBe("login");
  });

  it("writes login_succeeded (method=claim) on a successful account claim", async () => {
    const user = await seedUnclaimed("std-signin-claim");
    const res = await request("/auth/claim", {
      method: "POST",
      body: { identifier: user.studentId!, new_password: STRONG_PW, instagram: IG },
    });
    expect(res.status).toBe(200);

    // Claim writes BOTH the one-time identity proof and the sign-in event.
    expect(await auditCount("account_claimed", user.studentId!)).toBe(1);
    const [row] = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "login_succeeded"));
    expect(row).toBeTruthy();
    expect(row!.targetUserId).toBe(user.id);
    expect((row!.metadata as { method?: string }).method).toBe("claim");
  });

  it("does NOT write login_succeeded on a failed login", async () => {
    const admin = await seedUser({ role: "admin", email: "no-signin@example.test" });
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: "definitely-wrong" },
    });
    expect(res.status).toBe(401);
    expect(await auditCount("login_succeeded")).toBe(0);
  });
});
