import { jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";
import { eventFormVersions } from "./forms";
import { users } from "./users";

// Assessment (the "form 2") submissions — independent of registration answers (plan §3.2).
// One submission per (event, user) → award assessment_completed once. Mirrors registration answers shape.
export const assessmentSubmissions = pgTable(
  "assessment_submissions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    // The assessment form version the answers were validated against (frozen for this submission).
    formVersionId: uuid("form_version_id")
      .notNull()
      .references(() => eventFormVersions.id),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  // 1 assessment per (event,user) — DB-enforced idempotency for the "do it once" rule.
  (t) => [unique("assessment_sub_event_user_uq").on(t.eventId, t.userId)],
);

// Answer rows keyed by field key — mirrors registration_form_answers.
export const assessmentAnswers = pgTable(
  "assessment_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    submissionId: uuid("submission_id")
      .notNull()
      .references(() => assessmentSubmissions.id),
    formVersionId: uuid("form_version_id")
      .notNull()
      .references(() => eventFormVersions.id),
    fieldKey: text("field_key").notNull(),
    value: jsonb("value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("assessment_ans_sub_field_uq").on(t.submissionId, t.fieldKey)],
);

export type AssessmentSubmission = typeof assessmentSubmissions.$inferSelect;
export type AssessmentAnswer = typeof assessmentAnswers.$inferSelect;
