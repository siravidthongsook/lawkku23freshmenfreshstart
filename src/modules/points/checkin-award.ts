import { and, eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
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

// dedupeKey builders — user-scoped per registration (1 reg = 1 student) per addPoints invariant.
const inKey = (regId: string) => `checkin_in:${regId}`;
const outKey = (regId: string) => `checkin_out:${regId}`;

// Outcome surfaced back to the scan response so the UI can show "+N".
export type AwardOutcome = { pointsAwarded: number; deduped: boolean } | { pointsAwarded: 0; skipped: string };

// Award checkin_in points inside the caller's tx (scan IN success path).
// Guards: student only + toggle + cutoff. Idempotent via dedupeKey (rescan = no-op).
// Returns 0/skip reason on any guard miss so the caller never blocks the check-in itself.
export async function awardCheckinIn(
  tx: Tx,
  // scanMethod defaults to qr_scan; manual check-in passes "manual_search" so metadata reflects how it happened.
  args: { eventId: string; registrationId: string; studentUserId: string; studentRole: string; scannedByUserId: string; eventTitle?: string | null; scanMethod?: "qr_scan" | "manual_search" },
): Promise<AwardOutcome> {
  if (args.studentRole !== "student") return { pointsAwarded: 0, skipped: "not_student" };
  const settings = await getPointSettings(tx);
  const now = new Date();
  if (isPastCutoff(settings, now)) return { pointsAwarded: 0, skipped: "points_closed" };
  const config = await getEventPointConfig(args.eventId, tx);
  if (!isCheckinInEnabled(config)) return { pointsAwarded: 0, skipped: "checkin_in_disabled" };

  const points = effectiveCheckinInPoints(config, settings);
  const res = await addPoints(
    {
      userId: args.studentUserId,
      delta: points,
      reasonCode: "checkin_in",
      dedupeKey: inKey(args.registrationId),
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
  args: { eventId: string; registrationId: string; studentUserId: string; studentRole: string; scannedByUserId: string; eventTitle?: string | null },
): Promise<AwardOutcome> {
  if (args.studentRole !== "student") return { pointsAwarded: 0, skipped: "not_student" };
  const settings = await getPointSettings(tx);
  const now = new Date();
  if (isPastCutoff(settings, now)) return { pointsAwarded: 0, skipped: "points_closed" };
  const config = await getEventPointConfig(args.eventId, tx);
  const points = effectiveCheckinOutPoints(config, settings);
  const res = await addPoints(
    {
      userId: args.studentUserId,
      delta: points,
      reasonCode: "checkin_out",
      dedupeKey: outKey(args.registrationId),
      createdByUserId: args.scannedByUserId,
      metadata: { eventId: args.eventId, registrationId: args.registrationId, eventTitle: args.eventTitle ?? null, scanMethod: "qr_scan" },
    },
    tx,
  );
  return { pointsAwarded: res.deduped ? 0 : points, deduped: res.deduped };
}

// Reverse one awarded entry (looked up by dedupeKey) inside the undo tx. Internal helper.
// Idempotent: no-op if the original is missing / zero / already reversed (reversal_uq guards
// a double-reverse anyway). Posts a negative correction_reverse pointing at the original; addPoints
// keeps lastPositiveAt unchanged on a negative delta (M2 tie-break stays honest).
async function reverseAwardByDedupeKey(
  tx: Tx,
  args: { dedupeKey: string; studentUserId: string; undoneByUserId: string; reason: string },
): Promise<boolean> {
  const [orig] = await tx
    .select()
    .from(pointLedger)
    .where(eq(pointLedger.dedupeKey, args.dedupeKey))
    .limit(1);
  if (!orig) return false; // never awarded (toggle off / never checked out / pre-points reg)
  if (orig.delta === 0) return false;

  // Already reversed? then no-op (idempotent under repeated undo/redo).
  const [existingReversal] = await tx
    .select({ id: pointLedger.id })
    .from(pointLedger)
    .where(
      and(eq(pointLedger.reversalOfLedgerId, orig.id), eq(pointLedger.reasonCode, "correction_reverse")),
    )
    .limit(1);
  if (existingReversal) return false;

  await addPoints(
    {
      userId: args.studentUserId,
      delta: -orig.delta, // compensating negative; does NOT move lastPositiveAt
      reasonCode: "correction_reverse",
      reversalOfLedgerId: orig.id,
      createdByUserId: args.undoneByUserId,
      reason: args.reason,
      metadata: { reversedReason: "undo_checkin", originalReasonCode: orig.reasonCode, originalDelta: orig.delta },
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
  const common = { studentUserId: args.studentUserId, undoneByUserId: args.undoneByUserId, reason: args.reason };
  const inReversed = await reverseAwardByDedupeKey(tx, { dedupeKey: inKey(args.registrationId), ...common });
  const outReversed = await reverseAwardByDedupeKey(tx, { dedupeKey: outKey(args.registrationId), ...common });
  return { reversed: inReversed || outReversed };
}
