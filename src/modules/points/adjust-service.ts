import { and, eq } from "drizzle-orm";
import { db } from "../../db/client";
import { pointLedger, staffBudgetLedger } from "../../db/schema/points";
import { users } from "../../db/schema/users";
import { badRequest, notFound } from "../../lib/errors";
import { adjustBudget } from "./budget-service";
import { addPoints } from "./service";
import { getPointSettings, isPastCutoff } from "./config-service";

// === MANUAL ADJUST (plan §4.5) ===
// Admin: unlimited +/− to a student's points (does NOT touch budget).
// Staff: + only, debits their own budget (manual_grant) in the same tx; capped by budget.
// Target MUST be a student (only students earn). reason is REQUIRED (enforced at the route via Zod).
export type ManualAdjustResult =
  | { result: "adjusted"; delta: number; balance: number }
  | { result: "not_student" }
  | { result: "staff_must_be_positive" }
  | { result: "insufficient_budget" }
  | { result: "points_closed" };

export async function manualAdjust(args: {
  actorUserId: string;
  actorRole: string; // "admin" | "checkin_staff"
  actorName?: string | null;
  targetUserId: string;
  delta: number;
  reason: string;
}): Promise<ManualAdjustResult> {
  const isAdmin = args.actorRole === "admin";

  return db.transaction(async (tx): Promise<ManualAdjustResult> => {
    // Target must be an active student.
    const [target] = await tx
      .select({ role: users.role })
      .from(users)
      .where(eq(users.id, args.targetUserId))
      .limit(1);
    if (!target) throw notFound("User not found");
    if (target.role !== "student") return { result: "not_student" };

    // Cutoff freeze blocks STUDENT earning; admin correction bypasses cutoff (handled elsewhere),
    // but manual_adjust is an earning path so it stops at cutoff for both staff and admin.
    const settings = await getPointSettings(tx);
    if (isPastCutoff(settings, new Date())) return { result: "points_closed" };

    let budgetRowId: string | null = null;

    if (!isAdmin) {
      // Staff: positive only + budget-backed.
      if (args.delta <= 0) return { result: "staff_must_be_positive" };
      // Debit staff budget under lock; rejects insufficient_budget (thrown AppError → caller maps).
      try {
        const debit = await adjustBudget(
          {
            staffUserId: args.actorUserId,
            delta: -args.delta,
            reasonCode: "manual_grant",
            createdByUserId: args.actorUserId,
            targetUserId: args.targetUserId,
            auditAction: "budget_manual_grant", // distinct from admin topup/adjust for audit filtering (§15.5)
            rejectIfNegative: true,
            reason: args.reason,
          },
          tx,
        );
        budgetRowId = debit.entry.id;
      } catch (e) {
        if (e instanceof Error && "code" in e && (e as { code?: string }).code === "insufficient_budget")
          return { result: "insufficient_budget" };
        throw e;
      }
    }

    const award = await addPoints(
      {
        userId: args.targetUserId,
        delta: args.delta,
        reasonCode: "manual_adjust",
        createdByUserId: args.actorUserId,
        reason: args.reason,
        metadata: { actorName: args.actorName ?? null, actorRole: args.actorRole },
      },
      tx,
    );

    // Link the manual_grant budget row to the awarded ledger entry → U1 refund gate on reverse.
    if (budgetRowId) {
      await tx
        .update(staffBudgetLedger)
        .set({ relatedLedgerId: award.entry.id })
        .where(eq(staffBudgetLedger.id, budgetRowId));
    }

    return { result: "adjusted", delta: args.delta, balance: award.balance };
  });
}

// === ADMIN REVERSE (plan §4.6) ===
// Reverse ANY ledger entry: post a compensating correction_reverse (negative delta) pointing at it.
// Idempotent via point_ledger_reversal_uq. Does NOT move lastPositiveAt (addPoints handles that).
// Admin BYPASSES cutoff (U5 — dispute tool before results). reason REQUIRED.
// U1: if the original was a staff manual_grant (a staff_budget_ledger.manual_grant row links to it),
// refund that staff's budget; admin manual_adjust (no budget link) must NOT mint budget.
export type ReverseResult =
  | { result: "reversed"; budgetRefunded: number }
  | { result: "already_reversed" }
  | { result: "not_reversible" }
  | { result: "ledger_not_found" };

// Correction rows are themselves reversals/compensations — reversing one would re-credit points and
// enable self-cancelling chains (reversal_uq only blocks reversing the SAME original twice). Only an
// original EARNING entry may be reversed.
const NON_REVERSIBLE_REASONS = new Set(["correction_reverse", "correction_add"]);

export async function adminReverseLedgerEntry(args: {
  actorUserId: string;
  targetUserId: string;
  ledgerId: string;
  reason: string;
}): Promise<ReverseResult> {
  return db.transaction(async (tx): Promise<ReverseResult> => {
    const [orig] = await tx
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.id, args.ledgerId))
      .limit(1);
    if (!orig || orig.userId !== args.targetUserId) return { result: "ledger_not_found" };

    // Only an earning entry is reversible — never a correction_reverse/correction_add (no chains).
    if (NON_REVERSIBLE_REASONS.has(orig.reasonCode)) return { result: "not_reversible" };

    // Already reversed?
    const [existing] = await tx
      .select({ id: pointLedger.id })
      .from(pointLedger)
      .where(eq(pointLedger.reversalOfLedgerId, orig.id))
      .limit(1);
    if (existing) return { result: "already_reversed" };

    await addPoints(
      {
        userId: orig.userId,
        delta: -orig.delta,
        reasonCode: "correction_reverse",
        reversalOfLedgerId: orig.id,
        createdByUserId: args.actorUserId,
        reason: args.reason,
        auditAction: "point_reverse", // §15.5 — distinct from point_award for audit filtering
        metadata: { originalReasonCode: orig.reasonCode, originalDelta: orig.delta },
      },
      tx,
    );

    // U1 refund gate: only refund budget when a staff manual_grant budget row backs this entry.
    let budgetRefunded = 0;
    const [budgetRow] = await tx
      .select()
      .from(staffBudgetLedger)
      .where(
        and(
          eq(staffBudgetLedger.relatedLedgerId, orig.id),
          eq(staffBudgetLedger.reasonCode, "manual_grant"),
        ),
      )
      .limit(1);
    if (budgetRow) {
      const refund = -budgetRow.delta; // manual_grant delta is negative → refund the magnitude
      const res = await adjustBudget(
        {
          staffUserId: budgetRow.staffUserId,
          delta: refund,
          reasonCode: "grant_refund",
          createdByUserId: args.actorUserId,
          relatedLedgerId: orig.id,
          auditAction: "grant_refund",
          reason: args.reason,
        },
        tx,
      );
      budgetRefunded = res.entry.delta;
    }

    return { result: "reversed", budgetRefunded };
  });
}

// === ADMIN CORRECT (plan §4.6) ===
// Freeform correcting entry (correction_add). + tops up a system miss; − deducts. Bypasses cutoff.
export async function adminCorrect(args: {
  actorUserId: string;
  targetUserId: string;
  delta: number;
  reason: string;
}): Promise<
  { result: "corrected"; balance: number } | { result: "not_found" } | { result: "not_student" }
> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ id: users.id, role: users.role })
      .from(users)
      .where(eq(users.id, args.targetUserId))
      .limit(1);
    if (!target) return { result: "not_found" as const };
    // Only students hold points (§2 #8) — refuse to credit staff/admin even as a correction.
    if (target.role !== "student") return { result: "not_student" as const };
    const award = await addPoints(
      {
        userId: args.targetUserId,
        delta: args.delta,
        reasonCode: "correction_add",
        createdByUserId: args.actorUserId,
        reason: args.reason,
        auditAction: "point_correct", // §15.5 — distinct from point_award for audit filtering
        metadata: { correction: true },
      },
      tx,
    );
    return { result: "corrected" as const, balance: award.balance };
  });
}

// === STAFF SELF-REVERSE within window (plan §4.7) ===
// A staff member reverses THEIR OWN recent manual-grant. ALL must hold (else reject):
//   - entry.createdByUserId === actor               → not_your_grant
//   - entry.reasonCode === "manual_adjust"          → not_reversible (grant-QR uses token revoke)
//   - now - createdAt ≤ staffReverseWindowMin (>0)  → reverse_window_expired  (0 disables the feature)
//   - not already reversed                          → already_reversed
// On success: post the negative correction_reverse (lastPositiveAt unchanged) AND refund the staff
// budget (the grant debited it). Outside the window only admin can reverse (no time limit).
export type StaffReverseResult =
  | { result: "reversed"; budgetRefunded: number }
  | { result: "not_your_grant" }
  | { result: "not_reversible" }
  | { result: "reverse_window_expired" }
  | { result: "already_reversed" }
  | { result: "ledger_not_found" };

export async function staffSelfReverse(args: {
  actorUserId: string;
  actorIsAdmin: boolean;
  ledgerId: string;
  reason: string;
}): Promise<StaffReverseResult> {
  return db.transaction(async (tx): Promise<StaffReverseResult> => {
    const settings = await getPointSettings(tx);
    const windowMin = settings.staffReverseWindowMin;

    const [orig] = await tx
      .select()
      .from(pointLedger)
      .where(eq(pointLedger.id, args.ledgerId))
      .limit(1);
    if (!orig) return { result: "ledger_not_found" };

    // Ownership: staff may only reverse their own grants (admin bypasses ownership + window).
    if (!args.actorIsAdmin && orig.createdByUserId !== args.actorUserId)
      return { result: "not_your_grant" };
    // Only manual_adjust grants are self-reversible here (grant-QR → revoke token instead).
    if (orig.reasonCode !== "manual_adjust") return { result: "not_reversible" };

    // Time window (skip for admin). windowMin === 0 disables the staff feature entirely.
    if (!args.actorIsAdmin) {
      if (windowMin <= 0) return { result: "reverse_window_expired" };
      const ageMs = Date.now() - orig.createdAt.getTime();
      if (ageMs > windowMin * 60 * 1000) return { result: "reverse_window_expired" };
    }

    // Already reversed?
    const [existing] = await tx
      .select({ id: pointLedger.id })
      .from(pointLedger)
      .where(eq(pointLedger.reversalOfLedgerId, orig.id))
      .limit(1);
    if (existing) return { result: "already_reversed" };

    await addPoints(
      {
        userId: orig.userId,
        delta: -orig.delta,
        reasonCode: "correction_reverse",
        reversalOfLedgerId: orig.id,
        createdByUserId: args.actorUserId,
        reason: args.reason,
        auditAction: "point_reverse", // §15.5 — staff self-reverse is still a reverse for audit filtering
        metadata: { originalReasonCode: orig.reasonCode, originalDelta: orig.delta, selfReverse: true },
      },
      tx,
    );

    // Refund the staff budget that the grant debited — U1 gate: only when a manual_grant row links here.
    let budgetRefunded = 0;
    const [budgetRow] = await tx
      .select()
      .from(staffBudgetLedger)
      .where(
        and(
          eq(staffBudgetLedger.relatedLedgerId, orig.id),
          eq(staffBudgetLedger.reasonCode, "manual_grant"),
        ),
      )
      .limit(1);
    if (budgetRow) {
      const res = await adjustBudget(
        {
          staffUserId: budgetRow.staffUserId,
          delta: -budgetRow.delta, // manual_grant is negative → refund the magnitude
          reasonCode: "grant_refund",
          createdByUserId: args.actorUserId,
          relatedLedgerId: orig.id,
          auditAction: "grant_refund",
          reason: args.reason,
        },
        tx,
      );
      budgetRefunded = res.entry.delta;
    }

    return { result: "reversed", budgetRefunded };
  });
}
