import { pool } from "./client";
import { reconcilePoints } from "../modules/points/reconcile-service";

// Operational recovery tool (plan §9 phase 7 / §10): recompute truth from the append-only ledgers
// and reconcile the caches. Default = DRY-RUN report only. Pass --apply (or --fix) to repair in a tx.
//
//   pnpm reconcile:points          → report drift, write nothing
//   pnpm reconcile:points --apply  → correct users.pointsBalance / staffPointBudget / lastPositiveAt
//
// RUNBOOK: --apply does NOT row-lock users, so an award committing mid-reconcile could be clobbered.
// Run it in a quiet window (or after pausing awards) to avoid the reconcile-vs-concurrent-award race.
//
// Truth checked:
//   pointsBalance    == SUM(point_ledger.delta)        per user
//   staffPointBudget == SUM(staff_budget_ledger.delta) per staff
//   lastPositiveAt   == MAX(created_at) of POSITIVE-delta ledger rows (tie-break; reversals never set it)
async function main() {
  const apply = process.argv.includes("--apply") || process.argv.includes("--fix");

  // --apply writes caches without locking user rows — warn so it's run during a quiet window.
  if (apply) {
    console.warn("⚠  --apply writes without row-locking. Run during low traffic / paused awards.");
  }

  const r = await reconcilePoints({ apply });

  console.log(`reconcile-points (${apply ? "APPLY" : "dry-run"})`);
  console.log(
    `  users checked: ${r.totals.usersChecked}  staff checked: ${r.totals.staffChecked}`,
  );
  console.log(
    `  drift → balance: ${r.totals.balanceMismatches}  budget: ${r.totals.budgetMismatches}  lastPositiveAt: ${r.totals.lastPositiveMismatches}`,
  );

  for (const d of r.balanceDrift) {
    console.log(`  [balance]  user ${d.userId}  cached=${d.cached}  truth=${d.truth}  diff=${d.diff}`);
  }
  for (const d of r.budgetDrift) {
    console.log(`  [budget]   user ${d.userId}  cached=${d.cached}  truth=${d.truth}  diff=${d.diff}`);
  }
  for (const d of r.lastPositiveDrift) {
    console.log(`  [lastPos]  user ${d.userId}  cached=${d.cached ?? "null"}  truth=${d.truth ?? "null"}`);
  }

  const total =
    r.totals.balanceMismatches + r.totals.budgetMismatches + r.totals.lastPositiveMismatches;
  if (total === 0) {
    console.log("  no drift — caches match ledger truth ✓");
  } else if (apply) {
    console.log(`  repaired ${total} cache field(s) ✓`);
  } else {
    console.log(`  ${total} cache field(s) drifted — re-run with --apply to fix`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error("reconcile-points failed", err);
  process.exit(1);
});
