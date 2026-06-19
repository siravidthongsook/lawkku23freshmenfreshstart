import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import { staffBudgetLedger, type StaffBudgetLedgerRow } from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { writeAudit } from "../../lib/audit";
import { AppError, badRequest } from "../../lib/errors";

// Args for moving a staff member's grant budget. delta + = topup/refund, − = issue/manual_grant.
export type AdjustBudgetArgs = {
  staffUserId: string;
  delta: number;
  reasonCode: StaffBudgetLedgerRow["reasonCode"];
  createdByUserId: string; // admin for topups; the staff member for issue/manual
  grantTokenId?: string | null;
  targetUserId?: string | null; // student for manual_grant
  relatedLedgerId?: string | null; // point_ledger entry this budget move backs (manual_grant) — U1 refund gate
  reason?: string | null; // required for topup/admin_adjust at the route boundary (audited)
  metadata?: Record<string, unknown> | null;
  // Audit action code (plan §15.5): budget_topup / budget_adjust / grant_issue / grant_refund.
  auditAction?: string;
  // When true a debit (negative delta) that would push the cached budget below 0 is rejected.
  // Always true for grant_issue/manual_grant; admin_adjust passes this too (would_go_negative).
  rejectIfNegative?: boolean;
};

export type AdjustBudgetResult = {
  entry: StaffBudgetLedgerRow;
  budget: number; // staff budget after this call
};

// Core budget-movement, mirroring addPoints discipline:
// - tx + row-lock on the staff user row so concurrent budget changes serialize (no drift / negative budget).
// - append a staff_budget_ledger row, sync users.staffPointBudget in the SAME tx.
// - negative guard under the lock (rejectIfNegative): a grant/manual debit can't push budget below 0.
// - append-only audit written inside the same tx.
// Accepts an optional outer tx so callers (grant issue, manual adjust) compose this into their own tx.
export async function adjustBudget(
  args: AdjustBudgetArgs,
  outerTx?: Tx,
): Promise<AdjustBudgetResult> {
  const run = async (tx: Tx): Promise<AdjustBudgetResult> => {
    // Lock the staff user row → serializes read-modify-write of the budget cache.
    const [staff] = await tx
      .select({ id: users.id, budget: users.staffPointBudget })
      .from(users)
      .where(eq(users.id, args.staffUserId))
      .for("update")
      .limit(1);
    if (!staff) throw new Error(`adjustBudget: staff user not found ${args.staffUserId}`);

    // Negative guard (checked under the lock so it's race-safe).
    if (args.rejectIfNegative && staff.budget + args.delta < 0) {
      // Distinguish the two debit shapes the routes care about.
      const code = args.reasonCode === "admin_adjust" ? "would_go_negative" : "insufficient_budget";
      throw badRequest(code, "Staff budget would go negative");
    }

    const [entry] = await tx
      .insert(staffBudgetLedger)
      .values({
        staffUserId: args.staffUserId,
        delta: args.delta,
        reasonCode: args.reasonCode,
        grantTokenId: args.grantTokenId ?? null,
        targetUserId: args.targetUserId ?? null,
        relatedLedgerId: args.relatedLedgerId ?? null,
        createdByUserId: args.createdByUserId,
        reason: args.reason ?? null,
        metadata: args.metadata ?? null,
      })
      .returning();
    if (!entry) throw new Error("adjustBudget: ledger insert returned no row");

    await tx
      .update(users)
      .set({
        staffPointBudget: sql`${users.staffPointBudget} + ${args.delta}`,
        updatedAt: new Date(),
      })
      .where(eq(users.id, args.staffUserId));

    await writeAudit(
      {
        actorUserId: args.createdByUserId,
        action: args.auditAction ?? "budget_adjust",
        entityType: "staff_budget_ledger",
        entityId: entry.id,
        targetUserId: args.staffUserId,
        newValue: { delta: args.delta, reasonCode: args.reasonCode },
        reason: args.reason ?? null,
        metadata: args.metadata ?? null,
      },
      tx,
    );

    return { entry, budget: staff.budget + args.delta };
  };

  return outerTx ? run(outerTx) : db.transaction(run);
}

// Current cached staff budget (truth = SUM(staff_budget_ledger.delta); recompute reconciles drift).
export async function getStaffBudget(staffUserId: string, exec: Tx | typeof db = db): Promise<number> {
  const [row] = await exec
    .select({ b: users.staffPointBudget })
    .from(users)
    .where(eq(users.id, staffUserId))
    .limit(1);
  return row?.b ?? 0;
}

// Re-export so routes can `instanceof AppError` without importing errors twice. (intent: terse handlers)
export { AppError };
