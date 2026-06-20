import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { users } from "../../db/schema/users";

// Canonical leaderboard ordering (plan §0/§5, locked decisions):
//   pointsBalance DESC  → most points first
//   lastPositiveAt ASC  → on a tie, whoever reached that total FIRST wins (earliest positive entry)
//   id ASC              → final stable tiebreak so rank is deterministic across requests/pages
// NULLS LAST on lastPositiveAt: a 0-point student (never earned) sorts after anyone who has earned.
const ORDER_BY = [
  desc(users.pointsBalance),
  sql`${users.lastPositiveAt} asc nulls last`,
  asc(users.id),
];

// Leaderboard is app-wide and student-only (plan §6/§12.3): role='student' AND status='active'
// (H4 — disabled users keep a cached balance but must NOT place/win). Staff/admin never appear.
function leaderboardFilter(groupNumber: number | null) {
  // pointsBalance > 0: a student who never earned isn't ranked yet (Boss decision) — 0-point
  // students are hidden from the board entirely, not shown at the bottom.
  const base = and(eq(users.role, "student"), eq(users.status, "active"), gt(users.pointsBalance, 0));
  // Optional view-by-group filter only narrows the visible rows; rank stays app-wide (computed
  // separately, see rankOf). Group filtering uses the same ORDER BY for a consistent slice.
  return groupNumber == null ? base : and(base, eq(users.groupNumber, groupNumber));
}

export type LeaderboardRow = {
  rank: number; // app-wide rank (1-based), accounts for pagination offset
  userId: string;
  fullName: string;
  nickname: string | null;
  groupNumber: number | null;
  pointsBalance: number;
};

export type LeaderboardPage = {
  rows: LeaderboardRow[];
  total: number; // total students matching the (active + optional group) filter
};

// Paginated leaderboard. rank = offset + positional index + 1, which is correct because the
// ORDER BY is total and deterministic (no ties left unbroken) — row N over the whole ordered set
// has rank N. With a group filter, "rank" reflects rank WITHIN that filtered view (so #1 of a group
// is rank 1); the app-wide rank of any single user is fetched via rankOf().
export async function listLeaderboard(opts: {
  groupNumber: number | null;
  limit: number;
  offset: number;
}): Promise<LeaderboardPage> {
  const where = leaderboardFilter(opts.groupNumber);
  const [countRow] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(users)
    .where(where);
  const rows = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      nickname: users.nickname,
      groupNumber: users.groupNumber,
      pointsBalance: users.pointsBalance,
    })
    .from(users)
    .where(where)
    .orderBy(...ORDER_BY)
    .limit(opts.limit)
    .offset(opts.offset);
  return {
    rows: rows.map((r, i) => ({ rank: opts.offset + i + 1, ...r })),
    total: countRow?.c ?? 0,
  };
}

// The caller's OWN app-wide rank (plan §5/§14 "my rank") — so a student outside the visible page
// still sees where they stand. Rank = 1 + (# of active students strictly ahead in the ORDER BY).
// "Ahead" mirrors ORDER BY exactly: higher balance, OR same balance with an earlier lastPositiveAt,
// OR same balance + same lastPositiveAt (incl. both null) with a smaller id. Always app-wide
// (ignores any group filter). Returns null when the caller is not a ranked student (staff/admin,
// disabled, or no such user) — they have no leaderboard position.
export async function rankOf(userId: string): Promise<{ rank: number; pointsBalance: number } | null> {
  const [me] = await db
    .select({
      balance: users.pointsBalance,
      lastPositiveAt: users.lastPositiveAt,
      role: users.role,
      status: users.status,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  // Unranked until first point earned (matches leaderboardFilter's pointsBalance > 0).
  if (!me || me.role !== "student" || me.status !== "active" || me.balance <= 0) return null;

  // Count active students strictly ahead of me under the canonical ordering.
  // lastPositiveAt NULLS LAST: a null sorts AFTER any non-null, so "ahead on time" means the
  // other row's lastPositiveAt is non-null AND (mine is null OR theirs < mine).
  const [aheadRow] = await db
    .select({ ahead: sql<number>`count(*)::int` })
    .from(users)
    .where(
      and(
        eq(users.role, "student"),
        eq(users.status, "active"),
        sql`(
          ${users.pointsBalance} > ${me.balance}
          OR (${users.pointsBalance} = ${me.balance} AND ${users.lastPositiveAt} IS NOT NULL
              AND (${me.lastPositiveAt}::timestamptz IS NULL OR ${users.lastPositiveAt} < ${me.lastPositiveAt}::timestamptz))
          OR (${users.pointsBalance} = ${me.balance}
              AND (${users.lastPositiveAt} IS NOT DISTINCT FROM ${me.lastPositiveAt}::timestamptz)
              AND ${users.id} < ${userId})
        )`,
      ),
    );
  return { rank: (aheadRow?.ahead ?? 0) + 1, pointsBalance: me.balance };
}

// Full ordered list for CSV export (plan §5: announce results). No pagination — admin-only,
// run once at announcement time. Same ORDER BY so the export matches the on-screen leaderboard.
export async function listLeaderboardForExport(groupNumber: number | null): Promise<LeaderboardRow[]> {
  const rows = await db
    .select({
      userId: users.id,
      fullName: users.fullName,
      nickname: users.nickname,
      groupNumber: users.groupNumber,
      pointsBalance: users.pointsBalance,
    })
    .from(users)
    .where(leaderboardFilter(groupNumber))
    .orderBy(...ORDER_BY);
  return rows.map((r, i) => ({ rank: i + 1, ...r }));
}
