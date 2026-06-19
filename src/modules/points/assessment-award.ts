import type { Tx } from "../../db/client";
import { addPoints } from "./service";
import {
  effectiveAssessmentPoints,
  getEventPointConfig,
  getPointSettings,
  isAssessmentEnabled,
  isPastCutoff,
} from "./config-service";

// dedupeKey — user-scoped per (event,user) per the addPoints invariant (1 submission/event/user).
const assessmentKey = (eventId: string, userId: string) => `assessment:${eventId}:${userId}`;

// Outcome surfaced to the assessment-submit response so the UI can show "+N".
export type AssessmentAwardOutcome =
  | { pointsAwarded: number; deduped: boolean }
  | { pointsAwarded: 0; skipped: string };

// Award assessment_completed points inside the caller's tx (assessment submit success path).
// Guards: student only + assessmentEnabled toggle + cutoff. Idempotent via dedupeKey (resubmit = no-op).
// Returns 0/skip on any guard miss so the submission itself still records (forward-only, never blocks the row).
export async function awardAssessment(
  tx: Tx,
  args: {
    eventId: string;
    userId: string;
    userRole: string;
    submissionId: string;
    eventTitle?: string | null;
    submittedAt?: Date | null;
  },
): Promise<AssessmentAwardOutcome> {
  if (args.userRole !== "student") return { pointsAwarded: 0, skipped: "not_student" };
  const settings = await getPointSettings(tx);
  const now = new Date();
  if (isPastCutoff(settings, now)) return { pointsAwarded: 0, skipped: "points_closed" };
  const config = await getEventPointConfig(args.eventId, tx);
  if (!isAssessmentEnabled(config)) return { pointsAwarded: 0, skipped: "assessment_disabled" };

  const points = effectiveAssessmentPoints(config, settings);
  const res = await addPoints(
    {
      userId: args.userId,
      delta: points,
      reasonCode: "assessment_completed",
      dedupeKey: assessmentKey(args.eventId, args.userId),
      createdByUserId: null, // self-earned by the student; no actor
      metadata: {
        eventId: args.eventId,
        submissionId: args.submissionId,
        eventTitle: args.eventTitle ?? null,
        submittedAt: args.submittedAt?.toISOString() ?? null,
      },
    },
    tx,
  );
  return { pointsAwarded: res.deduped ? 0 : points, deduped: res.deduped };
}
