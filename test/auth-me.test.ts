import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { auditLogs } from "../src/db/schema/audit";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";

// PATCH /auth/me self-profile suite. Zero-coverage branches in src/modules/auth/routes.ts (~332):
// partial patch persistence, the cross-user email_taken conflict, null-clearing a nullable field,
// and the user_self_profile_updated audit old/new snapshot.

// Newest audit row for an action (throws if none) — DB is the source of truth for the snapshot.
async function auditRowFor(action: string) {
  const rows = await db
    .select()
    .from(auditLogs)
    .where(eq(auditLogs.action, action))
    .orderBy(sql`${auditLogs.createdAt} desc`);
  if (rows.length === 0) throw new Error(`no audit row for action ${action}`);
  return rows[0]!;
}

describe("PATCH /auth/me — self profile update", () => {
  it("applies a partial patch (full_name only) and returns the updated public user", async () => {
    const { user, cookie } = await loginAs("admin");
    const res = await request("/auth/me", {
      method: "PATCH",
      cookie,
      body: { full_name: "Renamed Self" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { full_name: string; email: string } };
    expect(body.user.full_name).toBe("Renamed Self");
    // Untouched field is preserved (email unchanged).
    expect(body.user.email).toBe(user.email);

    // Persisted to the DB, not just echoed.
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.fullName).toBe("Renamed Self");
  });

  it("rejects taking ANOTHER user's email with 409 email_taken (cross-user collision)", async () => {
    const other = await seedUser({ role: "student", email: "taken@example.test" });
    const { user, cookie } = await loginAs("admin");

    const res = await request("/auth/me", {
      method: "PATCH",
      cookie,
      body: { email: other.email },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "email_taken", message: "Email already in use" });

    // The email must NOT have changed on the actor (conflict throws before the update tx).
    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.email).toBe(user.email);
  });

  it("allows patching to the user's OWN current email (no false self-collision)", async () => {
    const { user, cookie } = await loginAs("admin");
    // Same email → the `body.email !== user.email` guard skips the uniqueness check entirely.
    const res = await request("/auth/me", {
      method: "PATCH",
      cookie,
      body: { email: user.email, phone: "0812345678" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { phone: string } };
    expect(body.user.phone).toBe("0812345678");
  });

  it("null-clears a nullable contact field (phone -> null)", async () => {
    const { user, cookie } = await loginAs("admin", { /* phone set below */ });
    // Seed a phone first so the clear is observable.
    await db.update(users).set({ phone: "0899999999" }).where(eq(users.id, user.id));

    const res = await request("/auth/me", {
      method: "PATCH",
      cookie,
      body: { phone: null },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { phone: string | null } };
    expect(body.user.phone).toBeNull();

    const [row] = await db.select().from(users).where(eq(users.id, user.id));
    expect(row!.phone).toBeNull();
  });

  it("writes a user_self_profile_updated audit row with old/new snapshot (actor==target==self)", async () => {
    const { user, cookie } = await loginAs("admin");
    const res = await request("/auth/me", {
      method: "PATCH",
      cookie,
      body: { full_name: "Audited Name", department: "Civil Law" },
    });
    expect(res.status).toBe(200);

    const row = await auditRowFor("user_self_profile_updated");
    expect(row.actorUserId).toBe(user.id);
    expect(row.targetUserId).toBe(user.id);
    expect(row.entityId).toBe(user.id);
    expect(row.entityType).toBe("user");
    // old snapshot = pre-patch value; new snapshot = post-patch value.
    expect((row.oldValue as { full_name: string }).full_name).toBe(user.fullName);
    expect((row.newValue as { full_name: string }).full_name).toBe("Audited Name");
    expect((row.newValue as { department: string }).department).toBe("Civil Law");
  });

  it("requires auth — PATCH /auth/me without a session is 401", async () => {
    const res = await request("/auth/me", { method: "PATCH", body: { full_name: "x" } });
    expect(res.status).toBe(401);
  });
});
