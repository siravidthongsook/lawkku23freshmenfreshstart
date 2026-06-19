import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { env } from "../src/env";
import { db } from "../src/db/client";
import { users, temporaryPasswords } from "../src/db/schema/users";
import { request } from "./helpers/db";
import {
  seedUser,
  login,
  loginAs,
  extractSessionCookie,
  type SessionCookie,
} from "./helpers/auth";

// Auth integration suite. Guards the login/session Hard Invariants from CLAUDE.md:
// generic login error (no enumeration), session lifecycle, status gating, password change.
// Asserts real status codes + the { error, message } error body shape.

const GENERIC_LOGIN_ERROR = { error: "invalid_credentials", message: "Invalid email or password" };

// Helper: read a user's must-change flag straight from the DB (seedUser can't set it).
async function setMustChange(userId: string): Promise<void> {
  await db.update(users).set({ passwordMustChange: true }).where(eq(users.id, userId));
}

describe("POST /auth/login — generic error / no user enumeration", () => {
  it("returns the SAME generic 401 for a wrong password AND a nonexistent user", async () => {
    const admin = await seedUser({ role: "admin" });

    const wrongPw = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: "definitely-not-the-password" },
    });
    const noUser = await request("/auth/login", {
      method: "POST",
      body: { identifier: "ghost@example.test", password: "definitely-not-the-password" },
    });

    // Critical invariant: both paths must be indistinguishable (same status + same body).
    expect(wrongPw.status).toBe(401);
    expect(noUser.status).toBe(401);
    const wrongPwBody = await wrongPw.json();
    const noUserBody = await noUser.json();
    expect(wrongPwBody).toEqual(GENERIC_LOGIN_ERROR);
    expect(noUserBody).toEqual(GENERIC_LOGIN_ERROR);
    expect(wrongPwBody).toEqual(noUserBody);
  });

  it("unclaimed account (null password hash) yields the same generic error — no 'not claimed' leak", async () => {
    // Imported staff/student before claim: passwordHash NULL. Login must not reveal this.
    const [row] = await db
      .insert(users)
      .values({
        email: "unclaimed@example.test",
        role: "student",
        fullName: "Unclaimed User",
        studentId: "std-unclaimed",
        status: "active",
        passwordHash: null,
      })
      .returning();

    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: row!.studentId!, password: "anything-at-all" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_LOGIN_ERROR);
  });
});

describe("POST /auth/login — success + session", () => {
  it("sets a session cookie on success and returns the public user + must-change flag", async () => {
    const admin = await seedUser({ role: "admin" });
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: admin.password },
    });
    expect(res.status).toBe(200);

    const cookie = extractSessionCookie(res);
    expect(cookie).not.toBeNull();

    const body = await res.json();
    expect(body.user.id).toBe(admin.id);
    expect(body.user.email).toBe(admin.email);
    expect(body.user.role).toBe("admin");
    // Public user must never leak the hash.
    expect(body.user).not.toHaveProperty("password_hash");
    expect(body.user).not.toHaveProperty("passwordHash");
    expect(body.password_must_change).toBe(false);
  });

  it("login by email is case-insensitive (stored vs typed casing)", async () => {
    const admin = await seedUser({ role: "admin", email: "case@example.test" });
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: "CASE@EXAMPLE.TEST", password: admin.password },
    });
    expect(res.status).toBe(200);
  });

  it("student logs in by student_id; admin logs in by email", async () => {
    const student = await loginAs("student");
    expect(student.cookie).toBeTruthy();
    const admin = await loginAs("admin");
    expect(admin.cookie).toBeTruthy();

    // checkin_staff: seedUser has no username, so they authenticate by email here.
    const staff = await seedUser({ role: "checkin_staff" });
    const staffCookie = await login(staff.email!, staff.password);
    expect(staffCookie).toBeTruthy();
  });

  it("surfaces password_must_change=true when the flag is set (temp-password flow)", async () => {
    // Admin-issued temp password sets must-change; login still succeeds but signals the change.
    const admin = await seedUser({ role: "admin" });
    await setMustChange(admin.id);
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: admin.password },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).password_must_change).toBe(true);
  });
});

describe("GET /auth/me", () => {
  it("returns the current user with a valid session cookie", async () => {
    const { user, cookie } = await loginAs("admin");
    const res = await request("/auth/me", { cookie });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.id).toBe(user.id);
    expect(body.user).not.toHaveProperty("password_hash");
  });

  it("returns 401 with the unauthorized error shape when no cookie is sent", async () => {
    const res = await request("/auth/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized", message: "Not authenticated" });
  });

  it("returns 401 for a garbage/forged cookie token", async () => {
    const res = await request("/auth/me", {
      cookie: `${env.SESSION_COOKIE_NAME}=not-a-real-token`,
    });
    expect(res.status).toBe(401);
  });
});

describe("user status gating", () => {
  it("a disabled user cannot log in — same generic 401 (no enumeration)", async () => {
    const disabled = await seedUser({ role: "admin", status: "disabled" });
    const res = await request("/auth/login", {
      method: "POST",
      body: { identifier: disabled.email, password: disabled.password },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(GENERIC_LOGIN_ERROR);
  });

  it("disabling a user after login invalidates their existing session (requireAuth rejects)", async () => {
    const { user, cookie } = await loginAs("admin");
    // Session is valid until the user row flips to disabled.
    expect((await request("/auth/me", { cookie })).status).toBe(200);
    await db.update(users).set({ status: "disabled" }).where(eq(users.id, user.id));
    const after = await request("/auth/me", { cookie });
    expect(after.status).toBe(401);
  });
});

describe("POST /auth/logout", () => {
  it("invalidates the session so subsequent /auth/me is 401", async () => {
    const { cookie } = await loginAs("admin");
    const out = await request("/auth/logout", { method: "POST", cookie });
    expect(out.status).toBe(200);
    expect(await out.json()).toEqual({ ok: true });

    const me = await request("/auth/me", { cookie });
    expect(me.status).toBe(401);
  });

  it("requires auth — logout without a session is 401", async () => {
    const res = await request("/auth/logout", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("POST /auth/change-password", () => {
  it("rejects a wrong current password with 400 invalid_current_password", async () => {
    const { cookie } = await loginAs("admin");
    const res = await request("/auth/change-password", {
      method: "POST",
      cookie,
      body: { current_password: "wrong-current", new_password: "brand-new-password-99" },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_current_password",
      message: "Current password is incorrect",
    });
  });

  it("rejects a new password that fails policy with 400 weak_password", async () => {
    const { password, cookie } = await loginAs("admin");
    const res = await request("/auth/change-password", {
      method: "POST",
      cookie,
      body: { current_password: password, new_password: "short" }, // < 10 chars
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("weak_password");
  });

  it("rotates the password: old one stops working, new one logs in, must-change cleared", async () => {
    const admin = await seedUser({ role: "admin" });
    await setMustChange(admin.id);
    const cookie = await login(admin.email!, admin.password);
    const newPassword = "rotated-password-2026";

    const change = await request("/auth/change-password", {
      method: "POST",
      cookie,
      body: { current_password: admin.password, new_password: newPassword },
    });
    expect(change.status).toBe(200);
    expect(await change.json()).toEqual({ ok: true });

    // Old password no longer authenticates.
    const oldPw = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: admin.password },
    });
    expect(oldPw.status).toBe(401);

    // New password works and must-change is now cleared.
    const newPw = await request("/auth/login", {
      method: "POST",
      body: { identifier: admin.email, password: newPassword },
    });
    expect(newPw.status).toBe(200);
    expect((await newPw.json()).password_must_change).toBe(false);
  });

  it("keeps the current session valid but revokes OTHER sessions on change", async () => {
    const admin = await seedUser({ role: "admin" });
    // Two independent logins → two sessions for the same user.
    const sessionA: SessionCookie = await login(admin.email!, admin.password);
    const sessionB: SessionCookie = await login(admin.email!, admin.password);

    // Change password using session A.
    const change = await request("/auth/change-password", {
      method: "POST",
      cookie: sessionA,
      body: { current_password: admin.password, new_password: "another-new-pass-77" },
    });
    expect(change.status).toBe(200);

    // Session A (the one that changed) stays valid.
    expect((await request("/auth/me", { cookie: sessionA })).status).toBe(200);
    // Session B (other session) is revoked.
    expect((await request("/auth/me", { cookie: sessionB })).status).toBe(401);
  });

  it("deletes the stored temporary password once the user sets their own", async () => {
    const admin = await seedUser({ role: "admin" });
    await setMustChange(admin.id);
    // Simulate an admin-issued temp password row (would normally come from the users module).
    await db.insert(temporaryPasswords).values({
      userId: admin.id,
      encryptedTempPassword: "fake-encrypted-blob",
      createdByAdminId: admin.id,
    });
    const cookie = await login(admin.email!, admin.password);

    await request("/auth/change-password", {
      method: "POST",
      cookie,
      body: { current_password: admin.password, new_password: "self-chosen-pass-88" },
    });

    const remaining = await db
      .select()
      .from(temporaryPasswords)
      .where(eq(temporaryPasswords.userId, admin.id));
    expect(remaining).toHaveLength(0);
  });

  it("requires auth — change-password without a session is 401", async () => {
    const res = await request("/auth/change-password", {
      method: "POST",
      body: { current_password: "x", new_password: "y" },
    });
    expect(res.status).toBe(401);
  });
});

describe("validation at the edge", () => {
  it("missing fields on /auth/login → 400 (zValidator rejects before the handler)", async () => {
    const res = await request("/auth/login", { method: "POST", body: { identifier: "x" } });
    expect(res.status).toBe(400);
    // NOTE: @hono/zod-validator short-circuits with its OWN body shape (a raw ZodError under
    // `error`) and never reaches the central errorHandler, so this is NOT the { error: code,
    // message } envelope used elsewhere. Asserting the ACTUAL behavior. See report.
    const body = await res.json();
    expect(body.error.name).toBe("ZodError");
    expect(body.error.issues[0].path).toContain("password");
  });
});
