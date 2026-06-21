import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users, temporaryPasswords } from "../src/db/schema/users";
import { auditLogs } from "../src/db/schema/audit";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";

// Admin user-management suite. Covers zero-coverage HIGH-tier branches in
// src/modules/users/routes.ts: unlock (end-to-end lock→unlock proving clearLockout's two clears),
// reset-password mode:"claim" (+ no_identifier guard), change-role (+ reason-required), and the
// disable/enable idempotent early-return (no audit row written).

const WRONG = "definitely-not-the-password";

// Count audit rows for an action (optionally filtered by target user id).
async function auditCount(action: string, targetUserId?: string): Promise<number> {
  const where = targetUserId
    ? sql`${auditLogs.action} = ${action} AND ${auditLogs.targetUserId} = ${targetUserId}`
    : eq(auditLogs.action, action);
  const [row] = await db.select({ c: sql<number>`count(*)::int` }).from(auditLogs).where(where);
  return row?.c ?? 0;
}

async function auditRowFor(action: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .orderBy(sql`${auditLogs.createdAt} desc`);
  if (rows.length === 0) throw new Error(`no audit row for action ${action}`);
  return rows[0]!;
}

// ---------------------------------------------------------------------------
// unlock — end-to-end: lock via failed logins, confirm blocked, admin unlock, confirm login works.
// Proves clearLockout clears BOTH the active lockout row AND the windowed fail-count path.
// ---------------------------------------------------------------------------
describe("POST /admin/users/:userId/unlock — end to end", () => {
  it("locks an account via 5 failed logins, admin unlock restores login, audits admin_unlocked_account", async () => {
    const { cookie: adminCookie } = await loginAs("admin");
    // Separate target account that we will lock out.
    const target = await seedUser({ role: "admin", email: "unlock-target@example.test" });

    // 5 wrong passwords → 5th crosses the threshold and sets the lockout window.
    for (let i = 0; i < 5; i++) {
      const res = await request("/auth/login", {
        method: "POST",
        body: { identifier: target.email, password: WRONG },
      });
      expect(res.status).toBe(401);
    }
    // Even the CORRECT password is now rejected — the account is locked, not just bad-cred.
    const lockedTry = await request("/auth/login", {
      method: "POST",
      body: { identifier: target.email, password: target.password },
    });
    expect(lockedTry.status).toBe(429);
    expect((await lockedTry.json()).error).toBe("rate_limited");

    // Admin unlocks the account.
    const unlock = await request(`/admin/users/${target.id}/unlock`, {
      method: "POST",
      cookie: adminCookie,
    });
    expect(unlock.status).toBe(200);
    expect(await unlock.json()).toEqual({ ok: true });

    // Login now SUCCEEDS — proves clearLockout cleared the lockout row AND detached the windowed fails.
    const after = await request("/auth/login", {
      method: "POST",
      body: { identifier: target.email, password: target.password },
    });
    expect(after.status).toBe(200);

    // Unlock audited with admin actor + target.
    expect(await auditCount("admin_unlocked_account", target.id)).toBe(1);
    const row = await auditRowFor("admin_unlocked_account");
    expect(row.targetUserId).toBe(target.id);
    expect(row.entityType).toBe("user");
  }, 30_000);
});

// ---------------------------------------------------------------------------
// reset-password mode:"claim" — wipes hash to NULL, drops temp pw row, plus the no_identifier guard.
// ---------------------------------------------------------------------------
describe("POST /admin/users/:userId/reset-password — claim mode", () => {
  it("wipes the hash to NULL and deletes the stored temp-password row (reset-to-claim)", async () => {
    const { cookie } = await loginAs("admin");
    // Target has a student_id (so claim is allowed) + a stale temp-pw row to be cleared.
    const target = await seedUser({ role: "student", studentId: "claim-reset-1" });
    await db.insert(temporaryPasswords).values({
      userId: target.id,
      encryptedTempPassword: "stale-encrypted-blob",
      createdByAdminId: target.id,
    });

    const res = await request(`/admin/users/${target.id}/reset-password`, {
      method: "POST",
      cookie,
      body: { reason: "force re-claim", mode: "claim" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    // Hash wiped to NULL (account must re-claim) and must_change cleared.
    const [row] = await db.select().from(users).where(eq(users.id, target.id));
    expect(row!.passwordHash).toBeNull();
    expect(row!.passwordMustChange).toBe(false);

    // Stale temp-pw row dropped.
    const temp = await db
      .select()
      .from(temporaryPasswords)
      .where(eq(temporaryPasswords.userId, target.id));
    expect(temp).toHaveLength(0);

    // Audit records the non-secret mode only.
    const audit = await auditRowFor("admin_password_reset");
    expect(audit.newValue).toEqual({ mode: "claim" });
    expect(audit.reason).toBe("force re-claim");
  });

  it("rejects claim-mode reset for a user with NO identifier (no student_id/username) → 409 no_identifier", async () => {
    const { cookie } = await loginAs("admin");
    // Email-only account: claim has nothing to claim with → must be blocked, else user is locked out.
    const [target] = await db
      .insert(users)
      .values({
        email: "no-identifier@example.test",
        role: "admin",
        fullName: "No Identifier",
        status: "active",
        passwordHash: "$argon2-placeholder", // value irrelevant; guard fires before any pw work
      })
      .returning();

    const res = await request(`/admin/users/${target!.id}/reset-password`, {
      method: "POST",
      cookie,
      body: { reason: "attempt re-claim", mode: "claim" },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("no_identifier");

    // Guard fires before the tx — no audit row, hash untouched.
    expect(await auditCount("admin_password_reset", target!.id)).toBe(0);
    const [row] = await db.select().from(users).where(eq(users.id, target!.id));
    expect(row!.passwordHash).toBe("$argon2-placeholder");
  });
});

// ---------------------------------------------------------------------------
// change-role — role actually changes + old/new audit + reason; reason-required → 400.
// ---------------------------------------------------------------------------
describe("POST /admin/users/:userId/change-role", () => {
  it("changes the role and audits user_role_changed with old/new + reason", async () => {
    const { user: admin, cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student", studentId: "role-1" });

    const res = await request(`/admin/users/${target.id}/change-role`, {
      method: "POST",
      cookie,
      body: { role: "checkin_staff", reason: "promoted to staff" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { role: string } };
    expect(body.user.role).toBe("checkin_staff");

    // Persisted.
    const [row] = await db.select().from(users).where(eq(users.id, target.id));
    expect(row!.role).toBe("checkin_staff");

    // Audit captures the transition + reason + correct actor.
    const audit = await auditRowFor("user_role_changed");
    expect(audit.actorUserId).toBe(admin.id);
    expect(audit.targetUserId).toBe(target.id);
    expect(audit.oldValue).toEqual({ role: "student" });
    expect(audit.newValue).toEqual({ role: "checkin_staff" });
    expect(audit.reason).toBe("promoted to staff");
  });

  it("requires a reason (sensitive-action invariant) → 400 with no role change", async () => {
    const { cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student", studentId: "role-2" });

    const res = await request(`/admin/users/${target.id}/change-role`, {
      method: "POST",
      cookie,
      body: { role: "admin" }, // missing reason
    });
    expect(res.status).toBe(400);

    // Role unchanged, no audit row.
    const [row] = await db.select().from(users).where(eq(users.id, target.id));
    expect(row!.role).toBe("student");
    expect(await auditCount("user_role_changed", target.id)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// disable/enable idempotent early-return — already-disabled / already-active write NO audit row.
// ---------------------------------------------------------------------------
describe("disable / enable idempotent early-return (no audit on no-op)", () => {
  it("disabling an already-disabled user is a no-op early-return with NO audit row", async () => {
    const { cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student", studentId: "dis-1", status: "disabled" });

    const res = await request(`/admin/users/${target.id}/disable`, {
      method: "POST",
      cookie,
      body: { reason: "redundant disable" },
    });
    expect(res.status).toBe(200);
    // Early return before the tx → no user_disabled audit row.
    expect(await auditCount("user_disabled", target.id)).toBe(0);
  });

  it("enabling an already-active user is a no-op early-return with NO audit row", async () => {
    const { cookie } = await loginAs("admin");
    const target = await seedUser({ role: "student", studentId: "en-1", status: "active" });

    const res = await request(`/admin/users/${target.id}/enable`, {
      method: "POST",
      cookie,
    });
    expect(res.status).toBe(200);
    expect(await auditCount("user_enabled", target.id)).toBe(0);
  });
});
