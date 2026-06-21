import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { sessions } from "../src/db/schema/sessions";
import { users } from "../src/db/schema/users";
import { request } from "./helpers/db";
import { loginAs, seedUser, login } from "./helpers/auth";

// Session security invariants (CLAUDE.md: server-side DB sessions, revoke-all on disable/reset,
// expiry enforced by gt(expiresAt, now)). These assert the session is ACTUALLY revoked/expired in
// the DB — not merely status-gated — so a live cookie can't outlive the account event.

describe("revokeAllSessions on admin disable", () => {
  it("kills the target's live session cookie (401) and marks the session row revoked", async () => {
    // Live student session that works before the disable.
    const target = await loginAs("student");
    expect((await request("/auth/me", { cookie: target.cookie })).status).toBe(200);

    // Admin disables the student (reason required by reasonSchema).
    const admin = await loginAs("admin");
    const disable = await request(`/admin/users/${target.user.id}/disable`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "security test — disable revokes sessions" },
    });
    expect(disable.status).toBe(200);

    // SAME cookie now rejected.
    expect((await request("/auth/me", { cookie: target.cookie })).status).toBe(401);

    // Assert the revocation is real in the DB (revokedAt stamped), not just user-status gating.
    const rows = await db.select().from(sessions).where(eq(sessions.userId, target.user.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.revokedAt).not.toBeNull();
  });
});

describe("revokeAllSessions on admin reset-password", () => {
  it("kills the target's live session after a temp-password reset and revokes the session row", async () => {
    const target = await loginAs("student");
    expect((await request("/auth/me", { cookie: target.cookie })).status).toBe(200);

    const admin = await loginAs("admin");
    const reset = await request(`/admin/users/${target.user.id}/reset-password`, {
      method: "POST",
      cookie: admin.cookie,
      body: { reason: "security test — reset revokes sessions", mode: "temp_password" },
    });
    expect(reset.status).toBe(200);

    // Live session is dead after reset.
    expect((await request("/auth/me", { cookie: target.cookie })).status).toBe(401);

    const rows = await db.select().from(sessions).where(eq(sessions.userId, target.user.id));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.revokedAt).not.toBeNull();
  });
});

describe("session expiry", () => {
  it("rejects a session whose expiresAt is in the past (gt(expiresAt, now) filter)", async () => {
    const student = await seedUser({ role: "student" });
    const cookie = await login(student.studentId!, student.password);
    // Sanity: valid before backdating.
    expect((await request("/auth/me", { cookie })).status).toBe(200);

    // Backdate the session's expiry directly in the DB (one hour in the past).
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await db.update(sessions).set({ expiresAt: past }).where(eq(sessions.userId, student.id));

    // resolveSession's gt(expiresAt, now) now excludes the row → unauthenticated.
    expect((await request("/auth/me", { cookie })).status).toBe(401);
  });

  it("an expired session is also distinct from a revoked one — both reject independently", async () => {
    // Guards that expiry alone (revokedAt still null) is enough to reject.
    const student = await seedUser({ role: "student" });
    const cookie = await login(student.studentId!, student.password);
    const past = new Date(Date.now() - 1000);
    await db.update(sessions).set({ expiresAt: past }).where(eq(sessions.userId, student.id));

    const [row] = await db.select().from(sessions).where(eq(sessions.userId, student.id)).limit(1);
    expect(row!.revokedAt).toBeNull(); // not revoked — purely expired
    expect((await request("/auth/me", { cookie })).status).toBe(401);
    // user still active — proves it's the expiry filter, not status gating.
    const [u] = await db.select().from(users).where(eq(users.id, student.id)).limit(1);
    expect(u!.status).toBe("active");
  });
});
