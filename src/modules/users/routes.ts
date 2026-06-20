import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
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
import { toBangkokString } from "../../lib/time";
import { toCsv } from "../exports/csv-out";
import { buildUserFilters } from "./query";
import {
  changeRoleSchema,
  createUserSchema,
  exportUsersQuery,
  listUsersQuery,
  reasonSchema,
  resetPasswordSchema,
  updateUserSchema,
  USER_EXPORT_COLUMNS,
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
  // Shared with the export endpoint so the list and the CSV always match for identical filters.
  const conds = buildUserFilters({ q, role, status, claimed });
  const where = conds.length ? and(...conds) : undefined;

  const [countRow] = await db.select({ c: sql<number>`count(*)::int` }).from(users).where(where);
  const total = countRow?.c ?? 0;

  // Sort column whitelisted by Zod; keep NULLs last in both directions (never-active users at the end).
  const sortCol = {
    created_at: users.createdAt,
    last_active_at: users.lastActiveAt,
    full_name: users.fullName,
    student_id: users.studentId,
    email: users.email,
    username: users.username,
    status: users.status,
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

// GET /admin/users/export — full filtered user list as CSV (NO pagination). Mirrors the list's
// filters via buildUserFilters so export == what the admin sees. Secrets are never exportable.
// NOTE: registered before the `/:userId` route so the literal path isn't captured as a param.
const USER_EXPORT_HARD_CAP = 50_000; // bound memory/response; warn + truncate beyond this.
// PDPA accountability: record WHICH user_ids were disclosed per export (subject-access + breach-scope).
// Cap the id list (append-only table — avoid unbounded audit-row bloat); distinct from the 50k ROW cap above.
const AUDIT_USER_IDS_CAP = 10_000;
router.get("/admin/users/export", zValidator("query", exportUsersQuery), async (c) => {
  const admin = c.get("user");
  const meta = requestMeta(c);
  const log = c.get("log");
  const f = c.req.valid("query");
  const { columns: requested, reason, ...filters } = f;

  // Resolve columns up-front so the plaintext-secret guard can fire before any DB/CSV/audit work.
  // temp_password is opt-in ONLY (must be explicitly requested) — the no-columns default never leaks plaintext.
  const columns = requested ?? USER_EXPORT_COLUMNS.filter((c) => c !== "temp_password");
  const includedTempPassword = columns.includes("temp_password");

  // Reason is required ONLY for the plaintext-secret column — guard fires first (no audit/CSV written).
  if (includedTempPassword && !reason) {
    return c.json(
      { error: "reason_required", message: "ต้องระบุเหตุผลเมื่อส่งออกรหัสผ่านชั่วคราว" },
      400,
    );
  }

  const conds = buildUserFilters(filters);
  const where = conds.length ? and(...conds) : undefined;

  // Pull one row over the cap so we can detect (and warn on) truncation deterministically.
  const rows = await db
    .select()
    .from(users)
    .where(where)
    .orderBy(desc(users.createdAt))
    .limit(USER_EXPORT_HARD_CAP + 1);

  const truncated = rows.length > USER_EXPORT_HARD_CAP;
  if (truncated) {
    rows.length = USER_EXPORT_HARD_CAP; // keep only the first 50k
    log?.set("export_truncated", true);
    log?.event("users_export_truncated", { cap: USER_EXPORT_HARD_CAP });
  }

  // Resolve pending temp-pw flag AND (only when exporting the plaintext column) decrypt it, in ONE query.
  // temp_password is decrypted on-export only; the plaintext is NEVER logged/audited (see audit call below).
  const ids = rows.map((r) => r.id);
  const pendingIds = new Set<string>();
  const tempPwById = new Map<string, string>();
  if (ids.length) {
    const pendingRows = await db
      .select({
        userId: temporaryPasswords.userId,
        encrypted: temporaryPasswords.encryptedTempPassword,
      })
      .from(temporaryPasswords)
      .where(inArray(temporaryPasswords.userId, ids));
    for (const p of pendingRows) {
      pendingIds.add(p.userId); // flag needs only existence — never decrypts
      // Decrypt only when the plaintext column was requested. Guard per-row: a single undecryptable
      // ciphertext (e.g. encrypted under a rotated TEMP_PW_ENC_KEY) must not 500 the whole export.
      if (includedTempPassword) {
        try {
          tempPwById.set(p.userId, decryptSecret(p.encrypted));
        } catch {
          tempPwById.set(p.userId, "<decrypt-error>");
          log?.event("temp_pw_decrypt_failed", { userId: p.userId });
        }
      }
    }
  }

  // Build the full allow-listed record per row. NO secret fields exist here by construction.
  const records = rows.map((u) => ({
    student_id: u.studentId ?? "",
    full_name: u.fullName,
    email: u.email ?? "",
    username: u.username ?? "",
    role: u.role,
    status: u.status,
    group_number: u.groupNumber ?? "",
    faculty: u.faculty ?? "",
    department: u.department ?? "",
    phone: u.phone ?? "",
    instagram: u.instagram ?? "",
    // Activation = self-set permanent password (hash set AND not must_change). Matches buildUserFilters' claimed signal.
    claimed: u.passwordHash !== null && u.passwordMustChange === false ? "yes" : "no",
    pending_temp_pw: pendingIds.has(u.id) ? "yes" : "no",
    // Decrypted plaintext temp pw (opt-in column, default unchecked in UI); "" when none pending.
    temp_password: tempPwById.get(u.id) ?? "",
    created_at_bangkok: toBangkokString(u.createdAt),
    last_active_at_bangkok: toBangkokString(u.lastActiveAt),
  }));

  // Columns resolved above (before the secret guard); just emit the CSV here.
  const csv = toCsv(records, columns);

  // Audit COUNT + filter summary only — never row content / PII / secrets.
  // included_temp_password flags every export where plaintext left the system (greppable for security review).
  log?.event("export", { kind: "users", rowCount: records.length });
  // PDPA: capture the disclosed users' UUIDs ONLY (no email/student_id/name). Cap the id list to bound
  // audit-row size; user_ids_truncated is the 10k id-list cap — separate from the 50k row `truncated` flag.
  const allExportedIds = rows.map((r) => r.id);
  const userIdsTruncated = allExportedIds.length > AUDIT_USER_IDS_CAP;
  const exportedUserIds = userIdsTruncated
    ? allExportedIds.slice(0, AUDIT_USER_IDS_CAP)
    : allExportedIds;
  await writeAudit({
    actorUserId: admin.id,
    actorRole: admin.role,
    action: "users_exported",
    entityType: "user",
    reason: includedTempPassword ? reason : null, // reason stored only for the plaintext-secret export
    metadata: {
      row_count: records.length,
      truncated,
      filters,
      columns,
      included_temp_password: includedTempPassword,
      exported_user_ids: exportedUserIds, // PDPA subject-access/breach-scope: UUIDs of disclosed users
      user_ids_truncated: userIdsTruncated,
    },
    ...meta,
  });

  const filename = `users-export-${exportDateStamp()}.csv`;
  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);
  c.header("X-Row-Count", String(records.length));
  c.header("Access-Control-Expose-Headers", "X-Row-Count, Content-Disposition");
  return c.body(csv);
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

// Filename date stamp YYYYMMDD in Bangkok time (display/export tz per CLAUDE.md).
function exportDateStamp(): string {
  const bkk = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return bkk.toISOString().slice(0, 10).replace(/-/g, "");
}

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
