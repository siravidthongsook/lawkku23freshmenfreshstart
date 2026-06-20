import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { events } from "../../db/schema/events";
import { eventFormVersions } from "../../db/schema/forms";
import { registrations } from "../../db/schema/registrations";
import { assessmentSubmissions } from "../../db/schema/assessments";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canEarnPoints, canManageEvents } from "../../lib/permissions";
import { forbidden, notFound } from "../../lib/errors";
import { writeAudit } from "../../lib/audit";
import { formSchema, type FormSchema } from "../../lib/form-schema";
import {
  createNewVersion,
  getActiveVersion,
  isStructuralChange,
  versionIsReferenced,
} from "../forms/service";
import { validateAgainstVersion, parseFormSchema } from "../registrations/service";
import {
  assessmentRequiresCheckin,
  assessmentWindow,
  getEventPointConfig,
  getPointSettings,
  isAssessmentEnabled,
  isPastCutoff,
} from "../points/config-service";
import { awardAssessment } from "../points/assessment-award";
import { getSubmission, serializeSubmission, writeAssessmentAnswers } from "./service";

const router = new Hono<{ Variables: AppVariables }>();

const eventIdParam = z.object({ eventId: z.string().uuid() });
const answersBody = z.object({ answers: z.record(z.string(), z.unknown()).default({}) });
const updateAssessmentFormBody = z.object({ schema: formSchema });

// Submit-outcome codes — returned in body (HTTP 200) so the UI branches; success/dup are not exceptions.
type SubmitResult =
  | "submitted_success"
  | "already_submitted"
  | "assessment_not_open" // before the assessment window opens
  | "assessment_closed" // past an explicit assessmentCloseAt override (default: never closes)
  | "no_assessment_form" // admin hasn't built an assessment form yet
  | "points_closed" // past the leaderboard cutoff
  | "checkin_required"; // assessmentRequiresCheckin && student not checked in

// Whether the registration counts as "attended" for the assessment gate: checked in, or scanned out
// (checkedOutAt set). status stays "checked_in" after scan-out, so either signal qualifies.
function attended(reg: { status: string; checkedOutAt: Date | null }): boolean {
  return reg.status === "checked_in" || reg.checkedOutAt != null;
}

// GET /events/:eventId/assessment — active assessment form + this student's submission status.
router.get("/events/:eventId/assessment", requireAuth, async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const user = c.get("user");
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw notFound("Event not found");

  // Only published events expose an assessment — mirrors the POST gate so a draft/cancelled/archived
  // event never renders a submittable form (the submit would be rejected anyway).
  if (event.status !== "published") {
    return c.json({ enabled: false, form: null, submitted: false, submission: null });
  }

  const version = await getActiveVersion(eventId, "assessment");
  const config = await getEventPointConfig(eventId);
  const submission = await getSubmission(db, eventId, user.id);

  // Frozen schema so the renderer can show real fields; null on missing/corrupt form.
  let form: { schema: unknown } | null = null;
  if (version) {
    try {
      form = { schema: parseFormSchema(version) };
    } catch {
      form = null;
    }
  }

  return c.json({
    enabled: isAssessmentEnabled(config),
    form: version ? { id: version.id, versionNumber: version.versionNumber, ...form } : null,
    submitted: submission != null,
    submission: submission ? serializeSubmission(submission) : null,
  });
});

// POST /events/:eventId/assessment — student submits the assessment → award assessment_completed once.
// Guard order: student → event published → toggle → cutoff → window → requires-checkin → active form
// → validate → insert submission (unique = already_submitted) → answers → award in the same tx.
router.post("/events/:eventId/assessment", requireAuth, async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = answersBody.parse(await c.req.json().catch(() => ({})));
  const user = c.get("user");
  const meta = requestMeta(c);
  const log = c.get("log");
  log.set("action", "assessment.submit").set("eventId", eventId); // WHAT — 5WH action marker

  // Only students earn points (plan §6/§15.1). Staff/admin have no balance/leaderboard.
  if (!canEarnPoints(user)) throw forbidden("Only students can submit assessments");

  type SubmitOut = { result: SubmitResult; submissionId?: string; pointsAwarded?: number };

  const out = await db.transaction(async (tx): Promise<SubmitOut> => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw notFound("Event not found");

    // Event must be published — a draft/cancelled/archived event can't award assessment points
    // (matches registration's event_not_open gate; keeps header guard order: student → published → …).
    if (event.status !== "published") return { result: "assessment_not_open" };

    const settings = await getPointSettings(tx);
    const config = await getEventPointConfig(eventId, tx);
    const now = new Date();

    // Toggle off → assessment isn't a thing for this event.
    if (!isAssessmentEnabled(config)) return { result: "assessment_not_open" };
    // Cutoff freeze blocks earning (the assessment only exists to award points).
    if (isPastCutoff(settings, now)) return { result: "points_closed" };

    // Window: open from eventStartAt (or override), never auto-closes. open=null + eventStartAt=null = open.
    const win = assessmentWindow(config, event);
    if (win.open != null && now < win.open) return { result: "assessment_not_open" };
    // Distinct from not-yet-open: only reachable via explicit assessmentCloseAt override (default never closes).
    if (win.close != null && now > win.close) return { result: "assessment_closed" };

    // Anti-farm (H3): require the student attended this event (checked in / out) when configured.
    if (assessmentRequiresCheckin(config)) {
      const [reg] = await tx
        .select({ status: registrations.status, checkedOutAt: registrations.checkedOutAt })
        .from(registrations)
        .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, user.id)))
        .limit(1);
      if (!reg || !attended(reg)) return { result: "checkin_required" };
    }

    // Active assessment form must exist before we can validate/store answers.
    const version = await getActiveVersion(eventId, "assessment");
    if (!version) return { result: "no_assessment_form" };

    // Validate answers against the frozen assessment schema (reuses registration validator).
    const values = validateAgainstVersion(version, body.answers);

    // One submission per (event,user). Insert is the idempotency point: a racing/repeat submit
    // hits the unique index → treat as already_submitted (no double award).
    const inserted = await tx
      .insert(assessmentSubmissions)
      .values({ eventId, userId: user.id, formVersionId: version.id, submittedAt: now })
      .onConflictDoNothing({
        target: [assessmentSubmissions.eventId, assessmentSubmissions.userId],
      })
      .returning();
    const submission = inserted[0];
    if (!submission) return { result: "already_submitted" };

    await writeAssessmentAnswers(tx, submission.id, version.id, values);

    // Award in the SAME tx; dedupeKey is the secondary guard (the unique submission is the primary one).
    const award = await awardAssessment(tx, {
      eventId,
      userId: user.id,
      userRole: user.role,
      submissionId: submission.id,
      eventTitle: event.title,
      submittedAt: submission.submittedAt,
    });

    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "assessment_submit",
        entityType: "assessment_submission",
        entityId: submission.id,
        eventId,
        targetUserId: user.id,
        newValue: { pointsAwarded: award.pointsAwarded },
        ...meta,
      },
      tx,
    );

    return { result: "submitted_success", submissionId: submission.id, pointsAwarded: award.pointsAwarded };
  });

  log.set("outcome", out.result);
  return c.json(out);
});

// =====================================================================
// ADMIN — assessment form builder (reuses the form-version machinery, formType="assessment")
// =====================================================================

// GET /admin/events/:eventId/forms/assessment — active assessment form (null if none built yet).
router.get(
  "/admin/events/:eventId/forms/assessment",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw notFound("Event not found");
    const active = await getActiveVersion(eventId, "assessment");
    return c.json({ form: active ?? null });
  },
);

// PUT /admin/events/:eventId/forms/assessment — safe edits in place; structural edits fork a new
// version once answers reference the active one (mirrors the registration-form PATCH semantics).
router.put(
  "/admin/events/:eventId/forms/assessment",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const body = updateAssessmentFormBody.parse(await c.req.json());
    const user = c.get("user");
    const meta = requestMeta(c);
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw notFound("Event not found");

    const active = await getActiveVersion(eventId, "assessment");

    // No active assessment version yet → bootstrap version 1.
    if (!active) {
      const created = await db.transaction((tx) =>
        createNewVersion(tx, { eventId, schema: body.schema, adminId: user.id, formType: "assessment" }),
      );
      await writeAudit({
        actorUserId: user.id,
        actorRole: user.role,
        action: "form_version_created",
        entityType: "event_form_version",
        entityId: created.id,
        eventId,
        newValue: { versionNumber: created.versionNumber, formType: "assessment" },
        ...meta,
      });
      return c.json({ form: created, versioned: true });
    }

    const oldSchema = formSchema.parse(active.schemaJson) as FormSchema;
    const structural = isStructuralChange(oldSchema, body.schema);
    // Fork when answers reference this version (versionIsReferenced now also counts assessment answers).
    const referenced = await versionIsReferenced(db, active.id);

    if (structural && referenced) {
      const created = await db.transaction((tx) =>
        createNewVersion(tx, { eventId, schema: body.schema, adminId: user.id, formType: "assessment" }),
      );
      await writeAudit({
        actorUserId: user.id,
        actorRole: user.role,
        action: "form_version_created",
        entityType: "event_form_version",
        entityId: created.id,
        eventId,
        oldValue: { versionNumber: active.versionNumber },
        newValue: { versionNumber: created.versionNumber, formType: "assessment", reason: "structural_change" },
        ...meta,
      });
      return c.json({ form: created, versioned: true });
    }

    // Safe edit, or structural edit on an unreferenced version → edit in place.
    const [updated] = await db
      .update(eventFormVersions)
      .set({ schemaJson: body.schema })
      .where(eq(eventFormVersions.id, active.id))
      .returning();
    return c.json({ form: updated, versioned: false });
  },
);

export default router;
