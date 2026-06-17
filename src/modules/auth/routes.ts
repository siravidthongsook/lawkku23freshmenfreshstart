import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq, or } from "drizzle-orm";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { users, temporaryPasswords } from "../../db/schema/users";
import { requireAuth, requestMeta } from "../../lib/auth-middleware";
import { AppError, badRequest } from "../../lib/errors";
import { hashPassword, validatePasswordPolicy, verifyPassword } from "../../lib/password";
import {
  clearSessionCookie,
  createSession,
  revokeOtherSessions,
  revokeSession,
} from "../../lib/session";
import { writeAudit } from "../../lib/audit";
import { changePasswordSchema, loginSchema } from "./schema";
import { checkRateLimit, recordAttempt } from "./service";

const router = new Hono<{ Variables: AppVariables }>();

// Generic credential error — used for every login failure (no user enumeration).
const invalidCredentials = () =>
  new AppError(401, "invalid_credentials", "Invalid email or password");

// POST /auth/login — rate-limited; disabled users cannot login.
router.post("/auth/login", zValidator("json", loginSchema), async (c) => {
  const { identifier, password } = c.req.valid("json");
  const meta = requestMeta(c);

  // Resolve by email OR student_id. Lookup is cheap; password work still gated behind rate-limit below.
  const [user] = await db
    .select()
    .from(users)
    .where(or(eq(users.email, identifier), eq(users.studentId, identifier)))
    .limit(1);

  // Canonical rate-limit key = the user's email when resolved, else the raw identifier typed.
  // Keeps lockout + admin unlock-by-email consistent regardless of which identifier was used.
  const rlKey = user?.email ?? identifier.toLowerCase();

  // Rate-limit / lockout gate runs before any password work.
  const rl = await checkRateLimit(rlKey, meta.ipAddress);
  if (rl.blocked) {
    await writeAudit({
      action: rl.lockedUntil ? "account_temporarily_locked" : "login_failed_rate_limited",
      entityType: "auth",
      metadata: { identifier, locked_until: rl.lockedUntil?.toISOString() ?? null },
      ...meta,
    });
    throw new AppError(429, "rate_limited", "Too many attempts. Try again later.");
  }

  // Same generic path whether user is missing, disabled, or password wrong.
  const ok = user && user.status === "active" && (await verifyPassword(user.passwordHash, password));
  if (!ok) {
    const { justLocked } = await recordAttempt(rlKey, meta.ipAddress, false);
    if (justLocked) {
      await writeAudit({
        action: "account_temporarily_locked",
        entityType: "auth",
        targetUserId: user?.id ?? null,
        metadata: { identifier },
        ...meta,
      });
    }
    throw invalidCredentials();
  }

  await recordAttempt(rlKey, meta.ipAddress, true);
  await createSession(c, user);
  return c.json({
    user: publicUser(user),
    password_must_change: user.passwordMustChange,
  });
});

// POST /auth/logout — revoke current session + clear cookie.
router.post("/auth/logout", requireAuth, async (c) => {
  const session = c.get("session");
  await revokeSession(session.id);
  clearSessionCookie(c);
  return c.json({ ok: true });
});

// POST /auth/change-password — verify current, apply policy, clear must-change, revoke other sessions.
router.post(
  "/auth/change-password",
  requireAuth,
  zValidator("json", changePasswordSchema),
  async (c) => {
    const user = c.get("user");
    const session = c.get("session");
    const { current_password, new_password } = c.req.valid("json");
    const meta = requestMeta(c);

    if (!(await verifyPassword(user.passwordHash, current_password))) {
      throw badRequest("invalid_current_password", "Current password is incorrect");
    }
    const policyErr = validatePasswordPolicy(new_password);
    if (policyErr) throw badRequest("weak_password", policyErr);

    const newHash = await hashPassword(new_password);
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash: newHash, passwordMustChange: false, updatedAt: new Date() })
        .where(eq(users.id, user.id));
      // Temp password no longer valid once user sets their own → drop it (blocks re-export).
      await tx.delete(temporaryPasswords).where(eq(temporaryPasswords.userId, user.id));
      await revokeOtherSessions(user.id, session.id, tx);
      await writeAudit(
        {
          actorUserId: user.id,
          actorRole: user.role,
          action: "password_changed",
          entityType: "user",
          entityId: user.id,
          targetUserId: user.id,
          ...meta,
        },
        tx,
      );
    });
    return c.json({ ok: true });
  },
);

// GET /auth/me — current user + role + must-change flag.
router.get("/auth/me", requireAuth, async (c) => {
  const user = c.get("user");
  return c.json({
    user: publicUser(user),
    password_must_change: user.passwordMustChange,
  });
});

// Shape of user we return over the wire — never includes password_hash.
function publicUser(u: typeof users.$inferSelect) {
  return {
    id: u.id,
    email: u.email,
    student_id: u.studentId,
    role: u.role,
    full_name: u.fullName,
    faculty: u.faculty,
    department: u.department,
    phone: u.phone,
    status: u.status,
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
  };
}

export default router;
