import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { pointGrantClaims, pointGrantTokens, pointLedger } from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { alias, type PgColumn } from "drizzle-orm/pg-core";

// Per-head listing of every student a given staff member granted points to (plan §7/§14
// "/admin/staff/:userId/grants"). Two sources, unioned in app code:
//   - QR:     point_grant_claims joined to tokens this staff issued (createdByUserId = staff)
//   - manual: point_ledger rows reason=manual_adjust, createdByUserId = staff
// Filterable by method (qr|manual) and a name/student-id search.
export type GrantMethod = "qr" | "manual";

export type StaffGrantRow = {
  method: GrantMethod;
  studentUserId: string;
  studentName: string;
  studentNickname: string | null;
  groupNumber: number | null;
  points: number;
  eventId: string | null;
  grantTokenId: string | null;
  ledgerId: string | null;
  reason: string | null;
  createdAt: string; // UTC ISO
};

export async function listStaffGrants(opts: {
  staffUserId: string;
  method?: GrantMethod; // omit = both
  q?: string | null; // name / student-id search
}): Promise<{ grants: StaffGrantRow[] }> {
  const q = opts.q?.trim() ? `%${opts.q.trim()}%` : null;
  // Name/student-id search over whichever users-table reference (base or alias) the join uses.
  // Accept either the base users table or an alias of it (PgColumn is structurally compatible).
  const nameMatch = (cols: { fullName: PgColumn; studentId: PgColumn; nickname: PgColumn }) =>
    q ? or(ilike(cols.fullName, q), ilike(cols.studentId, q), ilike(cols.nickname, q)) : undefined;

  const rows: StaffGrantRow[] = [];

  // --- QR grants: who claimed a token this staff issued ---
  if (opts.method !== "manual") {
    const qrRows = await db
      .select({
        studentUserId: users.id,
        studentName: users.fullName,
        studentNickname: users.nickname,
        groupNumber: users.groupNumber,
        points: pointGrantTokens.pointsValue,
        eventId: pointGrantTokens.eventId,
        grantTokenId: pointGrantTokens.id,
        createdAt: pointGrantClaims.createdAt,
      })
      .from(pointGrantClaims)
      .innerJoin(pointGrantTokens, eq(pointGrantClaims.grantTokenId, pointGrantTokens.id))
      .innerJoin(users, eq(pointGrantClaims.userId, users.id))
      .where(and(eq(pointGrantTokens.createdByUserId, opts.staffUserId), nameMatch(users)))
      .orderBy(desc(pointGrantClaims.createdAt));
    for (const r of qrRows) {
      rows.push({
        method: "qr",
        studentUserId: r.studentUserId,
        studentName: r.studentName,
        studentNickname: r.studentNickname,
        groupNumber: r.groupNumber,
        points: r.points,
        eventId: r.eventId,
        grantTokenId: r.grantTokenId,
        ledgerId: null,
        reason: null,
        createdAt: r.createdAt.toISOString(),
      });
    }
  }

  // --- Manual grants: point_ledger reason=manual_adjust created by this staff ---
  if (opts.method !== "qr") {
    const student = alias(users, "student");
    const manualRows = await db
      .select({
        ledgerId: pointLedger.id,
        studentUserId: student.id,
        studentName: student.fullName,
        studentNickname: student.nickname,
        groupNumber: student.groupNumber,
        points: pointLedger.delta,
        createdAt: pointLedger.createdAt,
      })
      .from(pointLedger)
      .innerJoin(student, eq(pointLedger.userId, student.id))
      .where(
        and(
          eq(pointLedger.createdByUserId, opts.staffUserId),
          eq(pointLedger.reasonCode, "manual_adjust"),
          nameMatch(student),
        ),
      )
      .orderBy(desc(pointLedger.createdAt));
    for (const r of manualRows) {
      rows.push({
        method: "manual",
        studentUserId: r.studentUserId,
        studentName: r.studentName,
        studentNickname: r.studentNickname,
        groupNumber: r.groupNumber,
        points: r.points,
        eventId: null,
        grantTokenId: null,
        ledgerId: r.ledgerId,
        reason: null, // manual-grant reason lives in the audit log, not the ledger row
        createdAt: r.createdAt.toISOString(),
      });
    }
  }

  // Merge both sources newest-first (both already sorted; merge by createdAt desc).
  rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  return { grants: rows };
}
