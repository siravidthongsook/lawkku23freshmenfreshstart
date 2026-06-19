import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import { pointLedger, staffBudgetLedger } from "../../db/schema/points";
import { users } from "../../db/schema/users";

// === Cache-drift reconciliation (plan §9 phase 7 / §10 "cache drift" safety net) ===
// Truth lives in the append-only ledgers; users.pointsBalance / users.staffPointBudget /
// users.lastPositiveAt are caches kept in sync inside each award tx. If a cache ever diverges
// (bug, manual SQL, partial failure), this recomputes truth from the ledgers and reports — or,
// with apply=true, repairs — the cache in one tx. Default is a dry-run report (no writes).
//
// Reconciled invariants (must hold for every user):
//   pointsBalance     == SUM(point_ledger.delta)            for that user
//   staffPointBudget  == SUM(staff_budget_ledger.delta)     for that staff
//   lastPositiveAt    == MAX(created_at) of POSITIVE-delta point_ledger rows (tie-break; reversals
//                        never set it — addPoints only advances it on delta > 0, so truth = max over
//                        positive rows only). null when the user has no positive entry.

export type BalanceDrift = {
  userId: string;
  cached: number;
  truth: number;
  diff: number; // truth - cached
};

export type BudgetDrift = {
  userId: string;
  cached: number;
  truth: number;
  diff: number;
};

// lastPositiveAt drift — compared at ms precision; ISO strings (or null) for a readable report.
export type LastPositiveDrift = {
  userId: string;
  cached: string | null;
  truth: string | null;
};

export type ReconcileReport = {
  balanceDrift: BalanceDrift[];
  budgetDrift: BudgetDrift[];
  lastPositiveDrift: LastPositiveDrift[];
  // Convenience totals for the CLI summary line.
  totals: {
    usersChecked: number;
    staffChecked: number;
    balanceMismatches: number;
    budgetMismatches: number;
    lastPositiveMismatches: number;
  };
  applied: boolean; // true when caches were corrected (apply mode)
};

type Exec = Tx | typeof db;

// Two timestamps are "equal" when within 1ms — pg timestamptz round-trips can differ sub-ms.
function tsEqual(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return Math.abs(a.getTime() - b.getTime()) < 1;
}

// Compute every drift row WITHOUT writing. Caller decides whether to apply.
async function computeDrift(exec: Exec) {
  // pointsBalance vs SUM(point_ledger.delta). LEFT JOIN so users with no ledger rows count as truth 0.
  const balanceRows = await exec
    .select({
      userId: users.id,
      cached: users.pointsBalance,
      truth: sql<number>`coalesce(sum(${pointLedger.delta}), 0)::int`,
      // MAX(created_at) over POSITIVE deltas only → lastPositiveAt truth (tie-break honesty).
      truthLastPositive: sql<Date | null>`max(${pointLedger.createdAt}) filter (where ${pointLedger.delta} > 0)`,
      cachedLastPositive: users.lastPositiveAt,
    })
    .from(users)
    .leftJoin(pointLedger, eq(pointLedger.userId, users.id))
    .groupBy(users.id, users.pointsBalance, users.lastPositiveAt);

  // staffPointBudget vs SUM(staff_budget_ledger.delta). Only users that have any budget ledger row
  // OR a non-zero cached budget can drift; LEFT JOIN keeps a non-zero cache with zero truth visible.
  const budgetRows = await exec
    .select({
      userId: users.id,
      cached: users.staffPointBudget,
      truth: sql<number>`coalesce(sum(${staffBudgetLedger.delta}), 0)::int`,
    })
    .from(users)
    .leftJoin(staffBudgetLedger, eq(staffBudgetLedger.staffUserId, users.id))
    .groupBy(users.id, users.staffPointBudget);

  const balanceDrift: BalanceDrift[] = [];
  const lastPositiveDrift: LastPositiveDrift[] = [];
  const lastPositiveFix = new Map<string, Date | null>();
  for (const r of balanceRows) {
    if (r.cached !== r.truth) {
      balanceDrift.push({ userId: r.userId, cached: r.cached, truth: r.truth, diff: r.truth - r.cached });
    }
    const truthLp = r.truthLastPositive ? new Date(r.truthLastPositive) : null;
    const cachedLp = r.cachedLastPositive ? new Date(r.cachedLastPositive) : null;
    if (!tsEqual(cachedLp, truthLp)) {
      lastPositiveDrift.push({
        userId: r.userId,
        cached: cachedLp?.toISOString() ?? null,
        truth: truthLp?.toISOString() ?? null,
      });
      lastPositiveFix.set(r.userId, truthLp);
    }
  }

  const budgetDrift: BudgetDrift[] = [];
  for (const r of budgetRows) {
    if (r.cached !== r.truth) {
      budgetDrift.push({ userId: r.userId, cached: r.cached, truth: r.truth, diff: r.truth - r.cached });
    }
  }

  return {
    balanceRows,
    budgetRows,
    balanceDrift,
    budgetDrift,
    lastPositiveDrift,
    lastPositiveFix,
  };
}

// Reconcile caches against ledger truth. apply=false (default) reports only; apply=true repairs in a tx.
export async function reconcilePoints(opts: { apply?: boolean } = {}): Promise<ReconcileReport> {
  const apply = opts.apply === true;

  const report = (
    d: Awaited<ReturnType<typeof computeDrift>>,
    applied: boolean,
  ): ReconcileReport => ({
    balanceDrift: d.balanceDrift,
    budgetDrift: d.budgetDrift,
    lastPositiveDrift: d.lastPositiveDrift,
    totals: {
      usersChecked: d.balanceRows.length,
      staffChecked: d.budgetRows.length,
      balanceMismatches: d.balanceDrift.length,
      budgetMismatches: d.budgetDrift.length,
      lastPositiveMismatches: d.lastPositiveDrift.length,
    },
    applied,
  });

  if (!apply) {
    const d = await computeDrift(db);
    return report(d, false);
  }

  // Apply: recompute INSIDE the tx (snapshot-consistent) and correct only the drifted rows.
  return db.transaction(async (tx) => {
    const d = await computeDrift(tx);
    for (const row of d.balanceDrift) {
      await tx.update(users).set({ pointsBalance: row.truth, updatedAt: new Date() }).where(eq(users.id, row.userId));
    }
    for (const row of d.budgetDrift) {
      await tx
        .update(users)
        .set({ staffPointBudget: row.truth, updatedAt: new Date() })
        .where(eq(users.id, row.userId));
    }
    for (const [userId, truthLp] of d.lastPositiveFix) {
      await tx.update(users).set({ lastPositiveAt: truthLp, updatedAt: new Date() }).where(eq(users.id, userId));
    }
    return report(d, true);
  });
}
