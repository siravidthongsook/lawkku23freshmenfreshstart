import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { DB, Tx } from "../../db/client";
import { pointLedger } from "../../db/schema/points";
import { addPoints } from "./service";
import {
  effectiveCheckinInPoints,
  effectiveCheckinOutPoints,
  getEventPointConfig,
  getPointSettings,
  isCheckinInEnabled,
  isCheckinOutEnabled,
  isPastCutoff,
} from "./config-service";

// === Versioned/epoch dedupe keys (re-check-in-after-undo support) ===
// dedupeKey is user-scoped per registration (1 reg = 1 student) per addPoints invariant, and now
// carries an epoch suffix `:v<k>`. k = number of prior awards for this (reg, reason) that are
// CURRENTLY net-reversed (have a matching correction_reverse). This keeps two behaviours honest:
//  - genuine double-scan WITHOUT an undo in between → latest award not reversed → same key → deduped (0).
//  - undo (reverses latest active award) then re-scan → latest award now reversed → k bumps → fresh key → re-award.
// Epoch is computed INSIDE the caller's tx (reg row already FOR UPDATE-locked) so concurrent re-scans serialize.
type CheckinReason = "checkin_in" | "checkin_out";
const epochKey = (reason: CheckinReason, regId: string, k: number) => `${reason}:${regId}:v${k}`;

// Count how many awards for this (reg, reason) are currently net-reversed → the next epoch to award at.
// Also = the epoch a fresh award should use (first scan: 0 reversed → v0).
async function reversedAwardCount(tx: Tx, reason: CheckinReason, regId: string): Promise<number> {
  // An award is "net-reversed" when a correction_reverse row points back at it (reversal_uq → at most one).
  const rev = tx
    .select({ id: pointLedger.reversalOfLedgerId })
    .from(pointLedger)
    .where(and(eq(pointLedger.reasonCode, "correction_reverse"), isNotNull(pointLedger.reversalOfLedgerId)))
    .as("rev");
  const [row] = await tx
    .select({ c: sql<number>`count(*)::int` })
    .from(pointLedger)
    .innerJoin(rev, eq(rev.id, pointLedger.id))
    .where(
      and(
        eq(pointLedger.reasonCode, reason),
        sql`${pointLedger.dedupeKey} like ${`${reason}:${regId}:v%`}`,
      ),
    );
  return row?.c ?? 0;
}

// Locate the CURRENT active (latest, not-yet-reversed) award row for this (reg, reason), or null.
// Used by undo to reverse the right epoch instead of a hardcoded :v0.
async function activeAwardRow(tx: Tx, reason: CheckinReason, regId: string) {
  const [row] = await tx
    .select({ id: pointLedger.id, delta: pointLedger.delta, dedupeKey: pointLedger.dedupeKey })
    .from(pointLedger)
    .where(
      and(
        eq(pointLedger.reasonCode, reason),
        sql`${pointLedger.dedupeKey} like ${`${reason}:${regId}:v%`}`,
        // not yet reversed: no correction_reverse points back at this row
        sql`not exists (select 1 from ${pointLedger} r where r.reversal_of_ledger_id = ${pointLedger.id} and r.reason_code = 'correction_reverse')`,
      ),
    )
    // Tiebreak on id: if two epochs ever shared created_at (tx-start now()), pick the truly-latest row deterministically.
    .orderBy(desc(pointLedger.createdAt), desc(pointLedger.id))
    .limit(1);
  return row ?? null;
}

// Read-only preview of the CURRENT active (not-yet-reversed) award delta per leg for one registration.
// Powers the admin panel warning "clearing this stamp also removes N points". null = no active award.
// Mirrors activeAwardRow's "not yet reversed" predicate; safe on db or tx.
export async function getActiveCheckinPoints(
  exec: DB | Tx,
  registrationId: string,
): Promise<{ checkinIn: number | null; checkinOut: number | null }> {
  const leg = async (reason: CheckinReason): Promise<number | null> => {
    const [row] = await exec
      .select({ delta: pointLedger.delta })
      .from(pointLedger)
      .where(
        and(
          eq(pointLedger.reasonCode, reason),
          sql`${pointLedger.dedupeKey} like ${`${reason}:${registrationId}:v%`}`,
          sql`not exists (select 1 from ${pointLedger} r where r.reversal_of_ledger_id = ${pointLedger.id} and r.reason_code = 'correction_reverse')`,
        ),
      )
      .orderBy(desc(pointLedger.createdAt), desc(pointLedger.id))
      .limit(1);
    return row ? row.delta : null;
  };
  return { checkinIn: await leg("checkin_in"), checkinOut: await leg("checkin_out") };
}

// Outcome surfaced back to the scan response so the UI can show "+N".
export type AwardOutcome = { pointsAwarded: number; deduped: boolean } | { pointsAwarded: 0; skipped: string };

// Award checkin_in points inside the caller's tx (scan IN success path).
// Guards: student only + toggle + cutoff. Idempotent via dedupeKey (rescan = no-op).
// Returns 0/skip reason on any guard miss so the caller never blocks the check-in itself.
export async function awardCheckinIn(
  tx: Tx,
  // scanMethod defaults to qr_scan; manual check-in passes "manual_search", admin status-change "admin_override" — metadata reflects how it happened.
  args: { eventId: string; registrationId: string; studentUserId: string; studentRole: string; scannedByUserId: string; eventTitle?: string | null; scanMethod?: "qr_scan" | "manual_search" | "admin_override" },
): Promise<AwardOutcome> {
  if (args.studentRole !== "student") return { pointsAwarded: 0, skipped: "not_student" };
  const settings = await getPointSettings(tx);
  const now = new Date();
  if (isPastCutoff(settings, now)) return { pointsAwarded: 0, skipped: "points_closed" };
  const config = await getEventPointConfig(args.eventId, tx);
  if (!isCheckinInEnabled(config)) return { pointsAwarded: 0, skipped: "checkin_in_disabled" };

  const points = effectiveCheckinInPoints(config, settings);
  // Epoch = number of prior checkin_in awards for this reg that are net-reversed → fresh key after undo.
  const k = await reversedAwardCount(tx, "checkin_in", args.registrationId);
  const res = await addPoints(
    {
      userId: args.studentUserId,
      delta: points,
      reasonCode: "checkin_in",
      dedupeKey: epochKey("checkin_in", args.registrationId, k),
      createdByUserId: args.scannedByUserId,
      metadata: { eventId: args.eventId, registrationId: args.registrationId, eventTitle: args.eventTitle ?? null, scanMethod: args.scanMethod ?? "qr_scan" },
    },
    tx,
  );
  return { pointsAwarded: res.deduped ? 0 : points, deduped: res.deduped };
}

// Award checkin_out points inside the caller's tx (scan OUT success path). Same guards as IN.
export async function awardCheckinOut(
  tx: Tx,
  // scanMethod mirrors awardCheckinIn: qr_scan default, manual_search for the manual-checkout path.
  args: { eventId: string; registrationId: string; studentUserId: string; studentRole: string; scannedByUserId: string; eventTitle?: string | null; scanMethod?: "qr_scan" | "manual_search" | "admin_override" },
): Promise<AwardOutcome> {
  if (args.studentRole !== "student") return { pointsAwarded: 0, skipped: "not_student" };
  const settings = await getPointSettings(tx);
  const now = new Date();
  if (isPastCutoff(settings, now)) return { pointsAwarded: 0, skipped: "points_closed" };
  const config = await getEventPointConfig(args.eventId, tx);
  // Defense-in-depth: mirror awardCheckinIn's toggle guard so a future caller can't award when OUT is off.
  if (!isCheckinOutEnabled(config)) return { pointsAwarded: 0, skipped: "checkin_out_disabled" };
  const points = effectiveCheckinOutPoints(config, settings);
  // Same epoch scheme as IN: undo reverses the OUT leg too, so a re-scan after undo must re-award.
  const k = await reversedAwardCount(tx, "checkin_out", args.registrationId);
  const res = await addPoints(
    {
      userId: args.studentUserId,
      delta: points,
      reasonCode: "checkin_out",
      dedupeKey: epochKey("checkin_out", args.registrationId, k),
      createdByUserId: args.scannedByUserId,
      metadata: { eventId: args.eventId, registrationId: args.registrationId, eventTitle: args.eventTitle ?? null, scanMethod: args.scanMethod ?? "qr_scan" },
    },
    tx,
  );
  return { pointsAwarded: res.deduped ? 0 : points, deduped: res.deduped };
}

// Reverse the CURRENT active (latest, not-yet-reversed) award for this (reg, reason) inside the undo tx.
// Resolves the active epoch via activeAwardRow (NOT a hardcoded :v0) so re-do-after-undo cycles work.
// Idempotent: no-op when there is no active award (never awarded / already reversed / zero delta).
// Posts a negative correction_reverse pointing at the original; addPoints keeps lastPositiveAt
// unchanged on a negative delta (M2 tie-break stays honest). reversal_uq guards a double-reverse.
async function reverseActiveAward(
  tx: Tx,
  args: { reason: CheckinReason; registrationId: string; studentUserId: string; undoneByUserId: string; reason_: string },
): Promise<boolean> {
  const orig = await activeAwardRow(tx, args.reason, args.registrationId);
  if (!orig) return false; // never awarded, or latest award already reversed
  if (orig.delta === 0) return false;

  await addPoints(
    {
      userId: args.studentUserId,
      delta: -orig.delta, // compensating negative; does NOT move lastPositiveAt
      reasonCode: "correction_reverse",
      reversalOfLedgerId: orig.id,
      createdByUserId: args.undoneByUserId,
      reason: args.reason_,
      metadata: { reversedReason: "undo_checkin", originalReasonCode: args.reason, originalDelta: orig.delta },
    },
    tx,
  );
  return true;
}

// Reverse BOTH the checkin_in and checkin_out awards when a check-in is undone (U6). Inside the undo tx.
// OUT must reverse too: undo clears checkedOutAt, so leaving the +OUT in the ledger is phantom points
// (balance-reflects-reality) and would burn the checkin_out dedupeKey forever. Each leg is independently
// idempotent and a clean no-op when that leg was never awarded.
export async function reverseCheckinOnUndo(
  tx: Tx,
  args: { registrationId: string; studentUserId: string; undoneByUserId: string; reason: string },
): Promise<{ reversed: boolean }> {
  const common = {
    registrationId: args.registrationId,
    studentUserId: args.studentUserId,
    undoneByUserId: args.undoneByUserId,
    reason_: args.reason,
  };
  const inReversed = await reverseActiveAward(tx, { reason: "checkin_in", ...common });
  const outReversed = await reverseActiveAward(tx, { reason: "checkin_out", ...common });
  return { reversed: inReversed || outReversed };
}

// Reverse ONLY the checkin_out leg when a check-OUT is undone (manual undo-checkout). Unlike
// reverseCheckinOnUndo, the check-in stays intact — we only clear the scan-out stamp + its points.
// Idempotent; clean no-op when no active OUT award exists.
export async function reverseCheckoutOnUndo(
  tx: Tx,
  args: { registrationId: string; studentUserId: string; undoneByUserId: string; reason: string },
): Promise<{ reversed: boolean }> {
  const reversed = await reverseActiveAward(tx, {
    reason: "checkin_out",
    registrationId: args.registrationId,
    studentUserId: args.studentUserId,
    undoneByUserId: args.undoneByUserId,
    reason_: args.reason,
  });
  return { reversed };
}
