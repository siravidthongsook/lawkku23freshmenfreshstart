import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { users, temporaryPasswords } from "../../db/schema/users";
import { requireAuth, requestMeta } from "../../lib/auth-middleware";
import { getPointSettings } from "../points/config-service";
import { AppError, badRequest, conflict } from "../../lib/errors";
import {
  hashPassword,
  validatePasswordPolicy,
  verifyDummyPassword,
  verifyPassword,
} from "../../lib/password";
import {
  clearSessionCookie,
  createSession,
  revokeOtherSessions,
  revokeSession,
} from "../../lib/session";
import { writeAudit } from "../../lib/audit";
import { loginFailuresTotal, loginSuccessTotal } from "../../lib/metrics";
import { changePasswordSchema, claimSchema, loginSchema, updateOwnProfileSchema } from "./schema";
import { checkRateLimit, recordAttempt } from "./service";

const router = new Hono<{ Variables: AppVariables }>();

// Generic credential error — used for every login failure (no user enumeration).
const invalidCredentials = () =>
  new AppError(401, "invalid_credentials", "Invalid email or password");

// POST /auth/login — rate-limited; disabled users cannot login.
router.post("/auth/login", zValidator("json", loginSchema), async (c) => {
  const { identifier, password } = c.req.valid("json");
  const meta = requestMeta(c);
  const log = c.get("log");
  log.set("action", "auth.signin"); // WHAT — 5WH action marker for this handler
  log.set("identifier", identifier); // who is trying (not a secret); password never logged

  // Resolve by email OR student_id OR username. Lookup is cheap; password work still gated behind rate-limit below.
  const [user] = await db
    .select()
    .from(users)
    // Email match is case-insensitive (emails are case-insensitive in practice);
    // student_id + username (e.g. staff-01) stay exact. Fixes login failing when typed email casing != stored.
    .where(
      or(
        sql`lower(${users.email}) = lower(${identifier})`,
        eq(users.studentId, identifier),
        eq(users.username, identifier),
      ),
    )
    .limit(1);

  // Canonical rate-limit key = the user's email when resolved, else the raw identifier typed.
  // Keeps lockout + admin unlock-by-email consistent regardless of which identifier was used.
  const rlKey = user?.email ?? identifier.toLowerCase();
  log.event("user_lookup", { found: !!user, status: user?.status ?? null });

  // Rate-limit / lockout gate runs before any password work. Pick only safe fields (no raw row).
  const rl = await log.call(
    "checkRateLimit",
    { rlKey },
    () => checkRateLimit(rlKey, meta.ipAddress, meta.deviceId),
    (r) => ({ blocked: r.blocked, lockedUntil: r.lockedUntil, reason: r.reason }),
  );
  if (rl.blocked) {
    loginFailuresTotal.inc();
    log.set("rateLimitReason", rl.reason); // which dimension tripped: account | device | ip
    // Don't re-audit an already-active lockout on every blocked request (that was the audit-spam
    // source) — it's logged once at the transition below. Only audit the non-lockout rate-limit case.
    if (!rl.lockedUntil) {
      await writeAudit({
        action: "login_failed_rate_limited",
        entityType: "auth",
        metadata: { identifier, reason: rl.reason }, // reason not a secret; deviceId-derived dim is loggable
        ...meta,
      });
    } else {
      // WHERE — branch marker on the active-lockout sub-path only (the non-lockout RL branch audits above).
      log.event("rate_limited", { lockedUntil: rl.lockedUntil, reason: rl.reason });
    }
    log.set("outcome", rl.lockedUntil ? "locked_out" : "rate_limited");
    throw new AppError(429, "rate_limited", "Too many attempts. Try again later.");
  }

  // Same generic path whether user is missing, disabled, unclaimed (null hash), or password wrong.
  // Null passwordHash = account not yet claimed — never reveal that, falls through to generic error.
  // verifyPassword wrapped with a SAFE pick — never log the plaintext password arg (pass userId only).
  const verifiable = !!user && user.status === "active" && user.passwordHash !== null;
  let ok = false;
  if (verifiable) {
    ok = await log.call(
      "verifyPassword",
      { userId: user.id },
      () => verifyPassword(user.passwordHash as string, password),
      (r) => ({ ok: r }),
    );
  } else {
    // Equal work on miss: spend the same argon2 time against a decoy hash so response latency can't
    // distinguish a real claimed account (slow verify) from a missing/disabled/unclaimed one (fast).
    // Result is intentionally discarded — this branch always falls through to the generic 401 below.
    await verifyDummyPassword(password);
  }
  log.event("credential_check", { ok });
  if (!ok) {
    loginFailuresTotal.inc();
    const { justLocked } = await recordAttempt(rlKey, meta.ipAddress, meta.deviceId, false);
    if (justLocked) {
      await writeAudit({
        action: "account_temporarily_locked",
        entityType: "auth",
        targetUserId: user?.id ?? null,
        metadata: { identifier },
        ...meta,
      });
    }
    log.set("outcome", "bad_credentials");
    throw invalidCredentials();
  }
  // ok===true only via the verifiable branch (user present) — narrow it for the success path below.
  if (!user) throw invalidCredentials();

  await recordAttempt(rlKey, meta.ipAddress, meta.deviceId, true);
  // createSession returns { token, id }; capture id for the log (never the token).
  const session = await log.call(
    "createSession",
    { userId: user.id },
    () => createSession(c, user),
    (s) => ({ sessionId: s.id }),
  );
  loginSuccessTotal.inc();
  // 5WH terminal: WHO=userId, sessionId; WHAT outcome=success (action set at top).
  log.set("userId", user.id).set("role", user.role).set("sessionId", session.id).set("outcome", "success");
  // Sign-in success audit — single source of truth for "who actually got in". login_attempts only
  // records login-path success (claim writes none), so this uniform event covers both paths.
  await writeAudit({
    actorUserId: user.id,
    actorRole: user.role,
    action: "login_succeeded",
    entityType: "auth",
    targetUserId: user.id,
    metadata: { identifier, method: "login" },
    ...meta,
  });
  return c.json({
    user: publicUser(user),
    password_must_change: user.passwordMustChange,
  });
});

// POST /auth/claim — imported (email-less) user proves identity (identifier) and sets first password.
// identifier = student_id (students) OR username e.g. staff-01 (staff). Only unclaimed accounts (null hash) match.
// Every mismatch (not found / already claimed) returns the SAME generic error — no enumeration.
router.post("/auth/claim", zValidator("json", claimSchema), async (c) => {
  const { identifier, new_password, instagram } = c.req.valid("json");
  const meta = requestMeta(c);
  const log = c.get("log");
  log.set("identifier", identifier); // who is claiming (not a secret); password never logged

  // These users have no email — rate-limit key is the identifier itself (shares login's lockout machinery).
  const rlKey = identifier.toLowerCase();

  // Rate-limit / lockout gate runs before any DB work or hashing.
  const rl = await checkRateLimit(rlKey, meta.ipAddress, meta.deviceId);
  if (rl.blocked) {
    // Mirror login: lockout already audited at its transition edge; only log the non-lockout case.
    if (!rl.lockedUntil) {
      await writeAudit({
        action: "login_failed_rate_limited",
        entityType: "auth",
        metadata: { identifier, reason: rl.reason },
        ...meta,
      });
    }
    throw new AppError(429, "rate_limited", "Too many attempts. Try again later.");
  }

  // Validate password policy BEFORE the identity lookup — identity-independent so a weak password
  // returns the same 400 whether or not the (identifier, group) tuple exists. Avoids enumeration:
  // a post-lookup-only 400 would distinguish a valid unclaimed account from an invalid one.
  const policyErr = validatePasswordPolicy(new_password);
  if (policyErr) throw badRequest("weak_password", policyErr);

  // Match unclaimed account by (student_id OR username) + active status. Null hash = not yet claimed.
  const [user] = await db
    .select()
    .from(users)
    .where(
      and(
        or(eq(users.studentId, identifier), eq(users.username, identifier)),
        isNull(users.passwordHash),
        eq(users.status, "active"),
      ),
    )
    .limit(1);
  log.event("claim_lookup", { found: !!user });

  // Any mismatch → same generic invalid-credentials path as login (counts toward lockout). No enumeration.
  if (!user) {
    // Equal work on miss: a hit hashes the new password (slow); without this a miss would return fast,
    // letting latency enumerate valid unclaimed identifiers. Spend matching argon2 time, discard result.
    await verifyDummyPassword(new_password);
    const { justLocked } = await recordAttempt(rlKey, meta.ipAddress, meta.deviceId, false);
    if (justLocked) {
      await writeAudit({
        action: "account_temporarily_locked",
        entityType: "auth",
        metadata: { identifier },
        ...meta,
      });
    }
    throw invalidCredentials();
  }

  const passwordHash = await hashPassword(new_password);

  // Set the hash + audit atomically. Null-hash filter makes a concurrent re-claim match 0 rows;
  // if we lost that race the password was NOT persisted, so bail to the same generic error
  // (rolls back the audit) rather than mint a session / write a spurious account_claimed row.
  await db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ passwordHash, instagram, updatedAt: new Date() })
      .where(and(eq(users.id, user.id), isNull(users.passwordHash)))
      .returning({ id: users.id });
    if (updated.length === 0) throw invalidCredentials();
    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "account_claimed",
        entityType: "user",
        entityId: user.id,
        targetUserId: user.id,
        metadata: { identifier },
        ...meta,
      },
      tx,
    );
  });

  await recordAttempt(rlKey, meta.ipAddress, meta.deviceId, true);
  // New shape { token, id }; capture id so the claim-path session is logged too (token never logged).
  const { id: claimSessionId } = await createSession(c, user);
  log.set("userId", user.id).set("role", user.role).set("sessionId", claimSessionId);
  // Sign-in success audit (claim path) — same login_succeeded action so the audit log shows every
  // successful sign-in uniformly. account_claimed above is the one-time identity proof; this marks
  // the resulting session (method=claim distinguishes it).
  await writeAudit({
    actorUserId: user.id,
    actorRole: user.role,
    action: "login_succeeded",
    entityType: "auth",
    targetUserId: user.id,
    metadata: { identifier, method: "claim" },
    ...meta,
  });
  // Same shape as login. Claimed users set their own password → no forced change.
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

    // Unclaimed users (null hash) have no current password to verify — they must use /auth/claim instead.
    if (user.passwordHash === null || !(await verifyPassword(user.passwordHash, current_password))) {
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
  // Surface the student-points visibility switch so the nav can hide the points tabs (admin toggle).
  const settings = await getPointSettings();
  return c.json({
    user: publicUser(user),
    password_must_change: user.passwordMustChange,
    student_points_visible: settings.studentPointsVisible,
  });
});

// PATCH /auth/me — self-edit own profile (email + contact info). student_id/role stay admin-only.
router.patch("/auth/me", requireAuth, zValidator("json", updateOwnProfileSchema), async (c) => {
  const user = c.get("user");
  const meta = requestMeta(c);
  const body = c.req.valid("json");

  // Email is the login credential + unique; block taking another user's email.
  if (body.email && body.email !== user.email) {
    const [hit] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.email, body.email), ne(users.id, user.id)))
      .limit(1);
    if (hit) throw conflict("email_taken", "Email already in use");
  }

  // Build patch from provided keys only (null clears nullable contact fields).
  const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (body.email !== undefined) patch.email = body.email;
  if (body.full_name !== undefined) patch.fullName = body.full_name;
  if (body.faculty !== undefined) patch.faculty = body.faculty;
  if (body.department !== undefined) patch.department = body.department;
  if (body.phone !== undefined) patch.phone = body.phone;

  const snapshot = (u: typeof users.$inferSelect) => ({
    email: u.email,
    full_name: u.fullName,
    faculty: u.faculty,
    department: u.department,
    phone: u.phone,
  });

  const updated = await db.transaction(async (tx) => {
    const [row] = await tx.update(users).set(patch).where(eq(users.id, user.id)).returning();
    if (!row) throw new Error("expected one row from returning()");
    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "user_self_profile_updated",
        entityType: "user",
        entityId: user.id,
        targetUserId: user.id,
        oldValue: snapshot(user),
        newValue: snapshot(row),
        ...meta,
      },
      tx,
    );
    return row;
  });
  return c.json({ user: publicUser(updated) });
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
    group_number: u.groupNumber, // บรรพ — admin-managed, read-only for the user
    status: u.status,
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
  };
}

export default router;
