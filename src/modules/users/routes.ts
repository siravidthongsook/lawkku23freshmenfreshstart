import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { temporaryPasswords, users, type User } from "../../db/schema/users";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canManageUsers, canResetPassword } from "../../lib/permissions";
import { conflict, notFound } from "../../lib/errors";
import { generateTempPassword, hashPassword } from "../../lib/password";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { revokeAllSessions } from "../../lib/session";
import { writeAudit } from "../../lib/audit";
import { tempPwIssuedTotal } from "../../lib/metrics";
import { clearLockout, getLockoutState } from "../auth/service";
import {
  changeRoleSchema,
  createUserSchema,
  listUsersQuery,
  reasonSchema,
  resetPasswordSchema,
  updateUserSchema,
} from "./schema";

const router = new Hono<{ Variables: AppVariables }>();

// `.returning()` is typed as possibly-empty under noUncheckedIndexedAccess; we always insert/update one row.
function one<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error("expected one row from returning()");
  return row;
}

// Every route here is admin-only. canResetPassword == canManageUsers in V1, but keep semantics explicit.
router.use("/admin/users/*", requireAuth, requirePermission(canManageUsers));
router.use("/admin/users", requireAuth, requirePermission(canManageUsers));

// GET /admin/users — list/search/filter + limit/offset pagination (returns total for the pager).
// Each row carries has_pending_temp_password so the list can badge users awaiting first login.
router.get("/admin/users", zValidator("query", listUsersQuery), async (c) => {
  const { q, role, status, claimed, sort, order, limit, offset } = c.req.valid("query");
  const conds = [];
  if (role) conds.push(eq(users.role, role));
  if (status) conds.push(eq(users.status, status));
  // claimed=no -> never-claimed accounts (no password); claimed=yes -> password set.
  if (claimed === "no") conds.push(isNull(users.passwordHash));
  if (claimed === "yes") conds.push(isNotNull(users.passwordHash));
  if (q) {
    const pat = `%${q}%`;
    conds.push(
      or(
        ilike(users.email, pat),
        ilike(users.studentId, pat),
        ilike(users.username, pat), // staff login id searchable too
        ilike(users.fullName, pat),
      ),
    );
  }
  const where = conds.length ? and(...conds) : undefined;

  const [countRow] = await db.select({ c: sql<number>`count(*)::int` }).from(users).where(where);
  const total = countRow?.c ?? 0;

  // Sort column whitelisted by Zod; keep NULLs last in both directions (never-active users at the end).
  const sortCol = {
    created_at: users.createdAt,
    last_active_at: users.lastActiveAt,
    full_name: users.fullName,
    student_id: users.studentId,
  }[sort];
  const orderBy = sql`${sortCol} ${sql.raw(order === "asc" ? "asc" : "desc")} nulls last`;

  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(orderBy)
    .limit(limit)
    .offset(offset);

  // Resolve pending temp-pw flags in one query for the visible page only.
  const ids = rows.map((r) => r.id);
  const pendingIds = new Set<string>();
  if (ids.length) {
    const pendingRows = await db
      .select({ userId: temporaryPasswords.userId })
      .from(temporaryPasswords)
      .where(inArray(temporaryPasswords.userId, ids));
    for (const p of pendingRows) pendingIds.add(p.userId);
  }

  return c.json({
    users: rows.map((u) => ({ ...publicUser(u), has_pending_temp_password: pendingIds.has(u.id) })),
    total,
    limit,
    offset,
  });
});

// POST /admin/users — create + generate temp password (stored encrypted), must_change=true.
router.post("/admin/users", zValidator("json", createUserSchema), async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);
  const log = c.get("log");
  log.set("action", "user.create"); // WHAT — 5WH action marker
  const body = c.req.valid("json");

  if (body.email) await assertEmailFree(body.email, null);
  if (body.student_id) await assertStudentIdFree(body.student_id, null);

  // claim mode -> no password (hash NULL); user self-claims at /claim. temp_password -> admin-issued temp pw.
  const claimMode = body.provision_mode === "claim";
  const tempPw = claimMode ? null : generateTempPassword();
  const passwordHash = tempPw ? await hashPassword(tempPw) : null;

  const created = await db.transaction(async (tx) => {
    const row = one(
      await tx
        .insert(users)
        .values({
          email: body.email ?? null,
          studentId: body.student_id ?? null,
          role: body.role,
          fullName: body.full_name,
          faculty: body.faculty ?? null,
          department: body.department ?? null,
          phone: body.phone ?? null,
          passwordHash, // NULL in claim mode = account not yet claimed
          passwordMustChange: !claimMode, // claimed users set their own pw, no forced change
          createdByAdminId: admin.id,
        })
        .returning(),
    );
    // Only temp-pw accounts get an encrypted temp pw row (claim accounts have none to export).
    if (tempPw) {
      await tx.insert(temporaryPasswords).values({
        userId: row.id,
        encryptedTempPassword: encryptSecret(tempPw),
        createdByAdminId: admin.id,
      });
    }
    await writeAudit(
      {
        actorUserId: admin.id,
        actorRole: admin.role,
        action: "user_created",
        entityType: "user",
        entityId: row.id,
        targetUserId: row.id,
        newValue: {
          email: row.email,
          student_id: row.studentId,
          role: row.role,
          provision_mode: body.provision_mode,
        },
        ...meta,
      },
      tx,
    );
    return row;
  });
  // Count an admin-issued temp password (claim mode issues none).
  if (tempPw) tempPwIssuedTotal.inc();
  log.set("outcome", tempPw ? "created_temp_pw" : "created_claim");
  return c.json({ user: publicUser(created) }, 201);
});

// GET /admin/users/temp-passwords/count — pending temp-pw count, so the export page can show
// how many will be exported BEFORE downloading the plaintext file. No PII, no passwords.
// NOTE: registered before the `/:userId` route so the literal path isn't captured as a param.
router.get("/admin/users/temp-passwords/count", async (c) => {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(temporaryPasswords);
  return c.json({ count: row?.c ?? 0 });
});

// GET /admin/users/temp-passwords/export — decrypt + return ONLY pending users; audit count only.
// NOTE: registered before the `/:userId` route so the literal path isn't captured as a param.
router.get("/admin/users/temp-passwords/export", async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);

  const rows = await db
    .select({
      userId: users.id,
      email: users.email,
      studentId: users.studentId,
      fullName: users.fullName,
      role: users.role,
      encrypted: temporaryPasswords.encryptedTempPassword,
    })
    .from(temporaryPasswords)
    .innerJoin(users, eq(users.id, temporaryPasswords.userId))
    .orderBy(desc(temporaryPasswords.createdAt));

  const exported = rows.map((r) => ({
    user_id: r.userId,
    email: r.email,
    student_id: r.studentId,
    full_name: r.fullName,
    role: r.role,
    temp_password: decryptSecret(r.encrypted),
  }));

  // Audit logs the COUNT ONLY — never the passwords (also redacted defensively at write layer).
  await writeAudit({
    actorUserId: admin.id,
    actorRole: admin.role,
    action: "temp_password_exported",
    entityType: "user",
    metadata: { exported_user_count: exported.length },
    ...meta,
  });
  return c.json({ users: exported });
});

// GET /admin/users/:userId — detail (also surfaces pending temp-password flag + lockout state).
router.get("/admin/users/:userId", async (c) => {
  const user = await getUserOr404(c.req.param("userId"));
  const [pending] = await db
    .select({ userId: temporaryPasswords.userId })
    .from(temporaryPasswords)
    .where(eq(temporaryPasswords.userId, user.id))
    .limit(1);
  // Lockout state so the UI can show a lock badge + enable Unlock only when actually locked.
  // Lockout is keyed by the rate-limit key, which is the email when present else the login identifier.
  const lockout = await getLockoutState(lockoutKey(user));
  return c.json({
    user: publicUser(user),
    has_pending_temp_password: Boolean(pending),
    locked: lockout.locked,
    locked_until: lockout.lockedUntil,
  });
});

// PATCH /admin/users/:userId — edit profile; email/student_id stay unique; audit old/new.
router.patch("/admin/users/:userId", zValidator("json", updateUserSchema), async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);
  const target = await getUserOr404(c.req.param("userId"));
  const body = c.req.valid("json");

  if (body.email && body.email !== target.email) await assertEmailFree(body.email, target.id);
  if (body.student_id && body.student_id !== target.studentId)
    await assertStudentIdFree(body.student_id, target.id);
  if (body.username && body.username !== target.username)
    await assertUsernameFree(body.username, target.id);

  // Build patch from provided keys only (null clears nullable fields).
  const patch: Partial<typeof users.$inferInsert> = { updatedAt: new Date() };
  if (body.email !== undefined) patch.email = body.email;
  if (body.student_id !== undefined) patch.studentId = body.student_id;
  if (body.username !== undefined) patch.username = body.username; // staff login id
  if (body.full_name !== undefined) patch.fullName = body.full_name;
  if (body.faculty !== undefined) patch.faculty = body.faculty;
  if (body.department !== undefined) patch.department = body.department;
  if (body.phone !== undefined) patch.phone = body.phone;
  if (body.instagram !== undefined) patch.instagram = body.instagram; // IG handle
  if (body.group_number !== undefined) patch.groupNumber = body.group_number; // บรรพ

  const updated = await db.transaction(async (tx) => {
    const row = one(await tx.update(users).set(patch).where(eq(users.id, target.id)).returning());
    await writeAudit(
      {
        actorUserId: admin.id,
        actorRole: admin.role,
        action: "user_profile_updated",
        entityType: "user",
        entityId: target.id,
        targetUserId: target.id,
        oldValue: profileSnapshot(target),
        newValue: profileSnapshot(row),
        ...meta,
      },
      tx,
    );
    return row;
  });
  return c.json({ user: publicUser(updated) });
});

// POST /admin/users/:userId/disable — disable + revoke all sessions. Reason required (sensitive: logs user out everywhere).
router.post("/admin/users/:userId/disable", zValidator("json", reasonSchema), async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);
  const { reason } = c.req.valid("json");
  const target = await getUserOr404(c.req.param("userId"));
  if (target.status === "disabled") return c.json({ user: publicUser(target) });

  const updated = await db.transaction(async (tx) => {
    const row = one(
      await tx
        .update(users)
        .set({ status: "disabled", updatedAt: new Date() })
        .where(eq(users.id, target.id))
        .returning(),
    );
    await revokeAllSessions(target.id, tx);
    await writeAudit(
      {
        actorUserId: admin.id,
        actorRole: admin.role,
        action: "user_disabled",
        entityType: "user",
        entityId: target.id,
        targetUserId: target.id,
        reason,
        ...meta,
      },
      tx,
    );
    return row;
  });
  return c.json({ user: publicUser(updated) });
});

// POST /admin/users/:userId/enable.
router.post("/admin/users/:userId/enable", async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);
  const target = await getUserOr404(c.req.param("userId"));
  if (target.status === "active") return c.json({ user: publicUser(target) });

  const updated = await db.transaction(async (tx) => {
    const row = one(
      await tx
        .update(users)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(users.id, target.id))
        .returning(),
    );
    await writeAudit(
      {
        actorUserId: admin.id,
        actorRole: admin.role,
        action: "user_enabled",
        entityType: "user",
        entityId: target.id,
        targetUserId: target.id,
        ...meta,
      },
      tx,
    );
    return row;
  });
  return c.json({ user: publicUser(updated) });
});

// POST /admin/users/:userId/reset-password — two modes:
//  - temp_password: new temp pw, set hash, upsert encrypted temp, revoke all sessions.
//  - claim: wipe hash to NULL + drop any temp pw row, revoke all sessions -> user must re-claim at /claim.
router.post(
  "/admin/users/:userId/reset-password",
  requirePermission(canResetPassword),
  zValidator("json", resetPasswordSchema),
  async (c) => {
    const admin = c.get("user");
    const meta = requestMeta(c);
    const log = c.get("log");
    log.set("action", "user.reset_password"); // WHAT — 5WH action marker
    const { reason, mode } = c.req.valid("json");
    const target = await getUserOr404(c.req.param("userId"));

    const claimMode = mode === "claim";
    // Reset-to-claim needs an identifier to claim with (student_id/username), else the user is locked out.
    if (claimMode && !target.studentId && !target.username) {
      throw conflict("no_identifier", "user has no identifier (student_id/username) to claim with");
    }

    const tempPw = claimMode ? null : generateTempPassword();
    const passwordHash = tempPw ? await hashPassword(tempPw) : null;

    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ passwordHash, passwordMustChange: !claimMode, updatedAt: new Date() })
        .where(eq(users.id, target.id));
      if (tempPw) {
        // Upsert encrypted temp so the new password can be exported.
        await tx
          .insert(temporaryPasswords)
          .values({
            userId: target.id,
            encryptedTempPassword: encryptSecret(tempPw),
            createdByAdminId: admin.id,
          })
          .onConflictDoUpdate({
            target: temporaryPasswords.userId,
            set: { encryptedTempPassword: encryptSecret(tempPw), createdByAdminId: admin.id, createdAt: new Date() },
          });
      } else {
        // Claim mode: no temp pw exists for this account anymore — clear any stale one.
        await tx.delete(temporaryPasswords).where(eq(temporaryPasswords.userId, target.id));
      }
      await revokeAllSessions(target.id, tx);
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "admin_password_reset",
          entityType: "user",
          entityId: target.id,
          targetUserId: target.id,
          reason,
          newValue: { mode },
          ...meta,
        },
        tx,
      );
    });
    // Count an admin-issued temp password (claim-mode reset issues none).
    if (tempPw) tempPwIssuedTotal.inc();
    log.set("outcome", claimMode ? "reset_to_claim" : "reset_temp_pw");
    return c.json({ ok: true });
  },
);

// GET /admin/users/:userId/temp-password — decrypt + return THIS user's pending temp pw (single-user reveal).
// Avoids exporting everyone just to resolve one person. 404 if no pending temp pw. Audits the reveal (no pw).
router.get("/admin/users/:userId/temp-password", async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);
  const target = await getUserOr404(c.req.param("userId"));

  const [row] = await db
    .select({ encrypted: temporaryPasswords.encryptedTempPassword })
    .from(temporaryPasswords)
    .where(eq(temporaryPasswords.userId, target.id))
    .limit(1);
  if (!row) throw notFound("no pending temporary password");

  await writeAudit({
    actorUserId: admin.id,
    actorRole: admin.role,
    action: "temp_password_revealed",
    entityType: "user",
    entityId: target.id,
    targetUserId: target.id,
    ...meta,
  });
  return c.json({ temp_password: decryptSecret(row.encrypted) });
});

// POST /admin/users/:userId/unlock — clear lockout rows for the user's email.
router.post("/admin/users/:userId/unlock", async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);
  const target = await getUserOr404(c.req.param("userId"));
  await clearLockout(lockoutKey(target));
  await writeAudit({
    actorUserId: admin.id,
    actorRole: admin.role,
    action: "admin_unlocked_account",
    entityType: "user",
    entityId: target.id,
    targetUserId: target.id,
    metadata: { email: target.email, identifier: lockoutKey(target) },
    ...meta,
  });
  return c.json({ ok: true });
});

// POST /admin/users/:userId/change-role — reason + audit. New sessions pick up new TTL naturally.
router.post(
  "/admin/users/:userId/change-role",
  zValidator("json", changeRoleSchema),
  async (c) => {
    const admin = c.get("user");
    const meta = requestMeta(c);
    const { role, reason } = c.req.valid("json");
    const target = await getUserOr404(c.req.param("userId"));

    const updated = await db.transaction(async (tx) => {
      const row = one(
        await tx
          .update(users)
          .set({ role, updatedAt: new Date() })
          .where(eq(users.id, target.id))
          .returning(),
      );
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "user_role_changed",
          entityType: "user",
          entityId: target.id,
          targetUserId: target.id,
          oldValue: { role: target.role },
          newValue: { role },
          reason,
          ...meta,
        },
        tx,
      );
      return row;
    });
    return c.json({ user: publicUser(updated) });
  },
);

// ---- helpers ----

// Rate-limit/lockout key for a user. Mirrors login's `user?.email ?? identifier`:
// email when present, else the login identifier (student_id or username) — email-less imported users.
function lockoutKey(u: User): string {
  return (u.email ?? u.studentId ?? u.username ?? u.id).toLowerCase();
}

async function getUserOr404(id: string): Promise<User> {
  const [row] = await db.select().from(users).where(eq(users.id, id)).limit(1);
  if (!row) throw notFound("User not found");
  return row;
}

// Unique-email guard. excludeId lets PATCH ignore the row being edited.
async function assertEmailFree(email: string, excludeId: string | null): Promise<void> {
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(excludeId ? and(eq(users.email, email), ne(users.id, excludeId)) : eq(users.email, email))
    .limit(1);
  if (hit) throw conflict("email_taken", "Email already in use");
}

async function assertStudentIdFree(studentId: string, excludeId: string | null): Promise<void> {
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      excludeId
        ? and(eq(users.studentId, studentId), ne(users.id, excludeId))
        : eq(users.studentId, studentId),
    )
    .limit(1);
  if (hit) throw conflict("student_id_taken", "Student ID already in use");
}

// Unique-username guard. excludeId lets PATCH ignore the row being edited.
async function assertUsernameFree(username: string, excludeId: string | null): Promise<void> {
  const [hit] = await db
    .select({ id: users.id })
    .from(users)
    .where(
      excludeId
        ? and(eq(users.username, username), ne(users.id, excludeId))
        : eq(users.username, username),
    )
    .limit(1);
  if (hit) throw conflict("username_taken", "Username already in use");
}

function profileSnapshot(u: User) {
  return {
    email: u.email,
    student_id: u.studentId,
    username: u.username,
    full_name: u.fullName,
    faculty: u.faculty,
    department: u.department,
    phone: u.phone,
  };
}

// Over-the-wire user shape — never includes password_hash.
function publicUser(u: User) {
  return {
    id: u.id,
    email: u.email,
    student_id: u.studentId,
    username: u.username, // staff login id
    role: u.role,
    full_name: u.fullName,
    faculty: u.faculty,
    department: u.department,
    phone: u.phone,
    instagram: u.instagram, // IG handle (collected at claim)
    group_number: u.groupNumber, // บรรพ
    status: u.status,
    claimed: u.passwordHash !== null, // false = claim account not yet self-claimed (no password set)
    password_must_change: u.passwordMustChange,
    created_at: u.createdAt.toISOString(),
    updated_at: u.updatedAt.toISOString(),
    last_active_at: u.lastActiveAt ? u.lastActiveAt.toISOString() : null, // null = never seen since launch
  };
}

export default router;
