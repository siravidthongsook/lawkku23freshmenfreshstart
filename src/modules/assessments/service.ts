import { and, eq } from "drizzle-orm";
import type { Tx } from "../../db/client";
import { db } from "../../db/client";
import { assessmentAnswers, assessmentSubmissions, type AssessmentSubmission } from "../../db/schema/assessments";
import type { AnswerMap } from "../../lib/form-schema";

type Exec = Tx | typeof db;

// Existing assessment submission for (event,user), or null. Drives the "already done?" UI state.
export async function getSubmission(
  exec: Exec,
  eventId: string,
  userId: string,
): Promise<AssessmentSubmission | null> {
  const [row] = await exec
    .select()
    .from(assessmentSubmissions)
    .where(and(eq(assessmentSubmissions.eventId, eventId), eq(assessmentSubmissions.userId, userId)))
    .limit(1);
  return row ?? null;
}

// Insert answer rows for a submission under its form version (mirrors registrations.writeAnswers).
export async function writeAssessmentAnswers(
  exec: Exec,
  submissionId: string,
  formVersionId: string,
  values: AnswerMap,
): Promise<void> {
  for (const [fieldKey, value] of Object.entries(values)) {
    await exec
      .insert(assessmentAnswers)
      .values({ submissionId, formVersionId, fieldKey, value: value ?? null })
      .onConflictDoUpdate({
        target: [assessmentAnswers.submissionId, assessmentAnswers.fieldKey],
        set: { value: value ?? null },
      });
  }
}

// Serialize a submission row for API responses (UTC ISO timestamps).
export function serializeSubmission(s: AssessmentSubmission) {
  return {
    id: s.id,
    eventId: s.eventId,
    userId: s.userId,
    formVersionId: s.formVersionId,
    submittedAt: s.submittedAt.toISOString(),
  };
}
