import { eq, exists, gte, ilike, isNotNull, isNull, lte, not, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/client";
import { temporaryPasswords, users } from "../../db/schema/users";

// BKK is UTC+7, no DST. A Bangkok-local calendar date maps to a fixed UTC instant.
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000;

// Start-of-day (00:00:00 BKK) for a YYYY-MM-DD date, as a UTC instant.
function bkkDateStartUtc(date: string): Date {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) - BKK_OFFSET_MS);
}
// Inclusive end-of-day (23:59:59.999 BKK) for a YYYY-MM-DD date, as a UTC instant.
function bkkDateEndUtc(date: string): Date {
  return new Date(Date.parse(`${date}T23:59:59.999Z`) - BKK_OFFSET_MS);
}

// Filters shared by the admin users LIST and EXPORT endpoints. All optional; absent = no narrowing.
export type UserFilters = {
  q?: string; // matches email / student_id / username / full_name
  role?: "student" | "checkin_staff" | "admin";
  status?: "active" | "disabled";
  claimed?: "yes" | "no";
  pending_temp_pw?: "yes" | "no";
  group_number?: number;
  created_from?: string; // BKK-local YYYY-MM-DD
  created_to?: string; // BKK-local YYYY-MM-DD (inclusive end of day)
  never_active?: boolean;
};

// Single source of WHERE conditions for both LIST and EXPORT — guarantees export == what you see.
export function buildUserFilters(f: UserFilters): SQL[] {
  const conds: SQL[] = [];
  if (f.role) conds.push(eq(users.role, f.role));
  if (f.status) conds.push(eq(users.status, f.status));
  // claimed=no -> never-claimed accounts (no password); claimed=yes -> password set.
  if (f.claimed === "no") conds.push(isNull(users.passwordHash));
  if (f.claimed === "yes") conds.push(isNotNull(users.passwordHash));
  // pending_temp_pw: correlated EXISTS on the dedicated temp-pw table (a join-derived flag today).
  if (f.pending_temp_pw) {
    const sub = exists(
      db
        .select({ x: sql`1` })
        .from(temporaryPasswords)
        .where(eq(temporaryPasswords.userId, users.id)),
    );
    conds.push(f.pending_temp_pw === "yes" ? sub : not(sub));
  }
  if (f.group_number !== undefined) conds.push(eq(users.groupNumber, f.group_number));
  if (f.created_from) conds.push(gte(users.createdAt, bkkDateStartUtc(f.created_from)));
  if (f.created_to) conds.push(lte(users.createdAt, bkkDateEndUtc(f.created_to)));
  // never_active=true -> users with no recorded activity since launch.
  if (f.never_active) conds.push(isNull(users.lastActiveAt));
  if (f.q) {
    const pat = `%${f.q}%`;
    const cond = or(
      ilike(users.email, pat),
      ilike(users.studentId, pat),
      ilike(users.username, pat), // staff login id searchable too
      ilike(users.fullName, pat),
    );
    if (cond) conds.push(cond);
  }
  return conds;
}
