import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db, type Tx } from "../../db/client";
import { events } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { users } from "../../db/schema/users";
import { auditLogs } from "../../db/schema/audit";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canManageEvents } from "../../lib/permissions";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { writeAudit } from "../../lib/audit";
import { capacityRejectionsTotal, registrationsTotal } from "../../lib/metrics";
import { isWithinWindow, effectiveCheckinClose } from "../../lib/time";
import {
  getEventPointConfig,
  getPointSettings,
  isCheckinOutEnabled,
  isPastCutoff,
  scanOutWindow,
  isScanOutOpen,
} from "../points/config-service";
import {
  issueQrToken,
  revokeActiveQrToken,
  hasActiveQrToken,
  getActiveQrTokenForOwner,
} from "../qr-tokens/service";
import { awardCheckinIn, reverseCheckinOnUndo } from "../points/checkin-award";
import {
  countActiveRegistrations,
  getActiveFormVersion,
  getAnswers,
  getEventOrThrow,
  getFileIds,
  getFiles,
  getFormVersionById,
  getRegistrationIdentity,
  getRegistrationOrThrow,
  listEventRegistrationsForAdmin,
  listUserRegistrationsWithEvent,
  parseFormSchema,
  searchUsersForRegistration,
  serializeRegistration,
  validateAgainstVersion,
  writeAnswers,
} from "./service";

const router = new Hono<{ Variables: AppVariables }>();

// ---- Zod boundary schemas ----
const eventIdParam = z.object({ eventId: z.string().uuid() });
const regIdParam = z.object({ registrationId: z.string().uuid() });
const answersBody = z.object({ answers: z.record(z.string(), z.unknown()).default({}) });
const reasonBody = z.object({ reason: z.string().min(1) });
const statusChangeBody = z.object({
  status: z.enum(["registered", "waitlisted", "checked_in", "cancelled"]),
  reason: z.string().min(1),
  // Award checkin_in points when transitioning INTO checked_in (default on, mirrors QR/manual scan).
  // Admin can opt OUT (e.g. a correction that shouldn't credit the student) by passing false.
  awardPoints: z.boolean().default(true),
});
const adminRegisterBody = z.object({
  userId: z.string().uuid(),
  answers: z.record(z.string(), z.unknown()).default({}),
  reason: z.string().min(1),
});
const adminAnswersBody = answersBody.extend({ reason: z.string().min(1) });

// Admin registration-list query: server-side search/filter/pagination.
const adminRegListQuery = z.object({
  q: z.string().trim().min(1).optional(), // student_id / email / full_name
  status: z.enum(["registered", "waitlisted", "checked_in", "cancelled"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// User typeahead query for the manual-register picker.
const userSearchQuery = z.object({
  q: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

// QR shown to students only when status is active+eligible and event is published.
function qrEligible(status: string, eventStatus: string): boolean {
  return (status === "registered" || status === "checked_in") && eventStatus === "published";
}

// One QR drives both check-in and check-out. This decides the current stage + whether to render the QR
// now, mirroring the scan-IN/OUT gates in checkins/routes so the student only sees it when scannable.
type QrPhase =
  | "checkin" // before check-in (QR shown while the check-in window is open)
  | "awaiting_checkout" // checked in; check-out enabled but its window hasn't opened yet
  | "checkout" // check-out window open (QR shown again)
  | "checkout_closed" // check-out window passed (or cutoff) without a scan
  | "done" // checked out, or event has no check-out
  | "unavailable"; // not eligible (cancelled/waitlisted/unpublished)

function computeQrPhase(
  reg: import("../../db/schema/registrations").Registration,
  event: import("../../db/schema/events").Event,
  config: Awaited<ReturnType<typeof getEventPointConfig>>,
  settings: Awaited<ReturnType<typeof getPointSettings>>,
  now: Date,
  eligible: boolean,
): { phase: QrPhase; showQr: boolean } {
  if (!eligible) return { phase: "unavailable", showQr: false };
  if (reg.checkedOutAt) return { phase: "done", showQr: false }; // nothing left to scan
  // Not yet checked in → show QR while the check-in window is open (event.checkinOpen/Close gate).
  if (reg.status !== "checked_in") {
    // Effective close = explicit close, else event end (scan-in must not outlast the event).
    return { phase: "checkin", showQr: isWithinWindow(now, event.checkinOpenAt, effectiveCheckinClose(event.checkinCloseAt, event.eventEndAt)) };
  }
  // Checked in, not out. No check-out for this event → done.
  if (!isCheckinOutEnabled(config)) return { phase: "done", showQr: false };
  if (isPastCutoff(settings, now)) return { phase: "checkout_closed", showQr: false }; // earning frozen
  const win = scanOutWindow(config, event, settings);
  // No anchor (no event end + no scan-out override) → scan-out never opens → checked-in is the end state.
  if (win.open == null && win.close == null) return { phase: "done", showQr: false };
  if (isScanOutOpen(win, now)) return { phase: "checkout", showQr: true };
  if (win.close && now > win.close) return { phase: "checkout_closed", showQr: false };
  return { phase: "awaiting_checkout", showQr: false }; // window hasn't opened yet
}

// =====================================================================
// STUDENT REGISTRATION
// =====================================================================

// Race-safe register: lock event row → validate answers → count capacity → insert + QR.
router.post("/events/:eventId/register", requireAuth, async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = answersBody.parse(await c.req.json().catch(() => ({})));
  const user = c.get("user");
  const meta = requestMeta(c);
  const log = c.get("log");
  log.set("action", "registration.submit").set("eventId", eventId); // WHAT — 5WH action marker

  const result = await db.transaction(async (tx) => {
    // Row-lock the event so concurrent submits serialize on capacity. Span the lock wait.
    const endLock = log.span("event_row_lock");
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update").limit(1);
    endLock();
    if (!event) throw notFound("Event not found");

    if (event.status !== "published")
      throw badRequest("event_not_open", "Event is not open for registration");
    if (event.registrationMode !== "public_self_register")
      throw forbidden("Self-registration is not allowed for this event");
    if (!isWithinWindow(new Date(), event.registrationOpenAt, event.registrationCloseAt))
      throw badRequest("registration_closed", "Registration window is closed");

    // Dup check under lock — return existing instead of erroring.
    const [existing] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, user.id)))
      .limit(1);
    if (existing && existing.status !== "cancelled") {
      return { reg: existing, qrToken: null as string | null, alreadyExisted: true };
    }

    const version = await getActiveFormVersion(tx, eventId);
    if (!version) throw badRequest("no_active_form", "Event has no active form version");
    const values = validateAgainstVersion(version, body.answers);

    // Capacity decides target status (excludes cancelled + waitlisted).
    const count = await countActiveRegistrations(tx, eventId);
    const capFull =
      event.capacityEnabled && event.capacityLimit != null && count >= event.capacityLimit;
    log.event("capacity_check", { enabled: event.capacityEnabled, limit: event.capacityLimit, used: count, full: capFull });
    let status: "registered" | "waitlisted";
    if (!capFull) status = "registered";
    else if (event.waitlistEnabled) status = "waitlisted";
    else {
      // Capacity-full reject path (no waitlist): count the rejection before bailing.
      capacityRejectionsTotal.inc();
      log.set("outcome", "capacity_full");
      throw conflict("registration_full", "Event is full");
    }

    const now = new Date();
    const reg = existing
      ? await reactivate(tx, existing.id, status, version.id, now)
      : await insertReg(tx, eventId, user.id, status, version.id, now);
    await writeAnswers(tx, reg.id, version.id, values);

    // QR only for confirmed registered (waitlisted gets none until promoted).
    let qrToken: string | null = null;
    if (status === "registered") qrToken = await issueQrToken(tx, reg.id, user.id);

    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "registration_created",
        entityType: "registration",
        entityId: reg.id,
        eventId,
        registrationId: reg.id,
        targetUserId: user.id,
        newValue: { status },
        ...meta,
      },
      tx,
    );
    return { reg, qrToken, alreadyExisted: false };
  });

  // Count a confirmed registration (registered status) by event; waitlisted/dup don't consume a slot.
  if (result.reg.status === "registered" && !result.alreadyExisted) {
    registrationsTotal.inc({ event: eventId });
  }
  log.set("outcome", result.alreadyExisted ? "already_registered" : result.reg.status);
  log.event("register_result", {
    status: result.reg.status,
    alreadyExisted: result.alreadyExisted,
    qrIssued: !!result.qrToken,
  });
  return c.json(
    {
      registration: serializeRegistration(result.reg),
      qrToken: result.qrToken, // plaintext, returned ONCE
      alreadyRegistered: result.alreadyExisted,
    },
    result.alreadyExisted ? 200 : 201,
  );
});

// Join waitlist explicitly (full + waitlist enabled).
router.post("/events/:eventId/join-waitlist", requireAuth, async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = answersBody.parse(await c.req.json().catch(() => ({})));
  const user = c.get("user");
  const meta = requestMeta(c);

  const result = await db.transaction(async (tx) => {
    const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update").limit(1);
    if (!event) throw notFound("Event not found");
    if (event.status !== "published") throw badRequest("event_not_open", "Event is not open");
    if (event.registrationMode !== "public_self_register")
      throw forbidden("Self-registration is not allowed for this event");
    if (!event.waitlistEnabled) throw badRequest("waitlist_disabled", "Waitlist is not enabled");
    if (!isWithinWindow(new Date(), event.registrationOpenAt, event.registrationCloseAt))
      throw badRequest("registration_closed", "Registration window is closed");

    const [existing] = await tx
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, user.id)))
      .limit(1);
    if (existing && existing.status !== "cancelled") return { reg: existing, alreadyExisted: true };

    const version = await getActiveFormVersion(tx, eventId);
    if (!version) throw badRequest("no_active_form", "Event has no active form version");
    const values = validateAgainstVersion(version, body.answers);

    const now = new Date();
    const reg = existing
      ? await reactivate(tx, existing.id, "waitlisted", version.id, now)
      : await insertReg(tx, eventId, user.id, "waitlisted", version.id, now);
    await writeAnswers(tx, reg.id, version.id, values);

    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "registration_created",
        entityType: "registration",
        entityId: reg.id,
        eventId,
        registrationId: reg.id,
        targetUserId: user.id,
        newValue: { status: "waitlisted" },
        ...meta,
      },
      tx,
    );
    return { reg, alreadyExisted: false };
  });

  return c.json(
    { registration: serializeRegistration(result.reg), waitlisted: true },
    result.alreadyExisted ? 200 : 201,
  );
});

// Student cancels own registration (only if event allows + before deadline + cancellable status).
router.post("/registrations/:registrationId/cancel", requireAuth, async (c) => {
  const { registrationId } = regIdParam.parse(c.req.param());
  const user = c.get("user");
  const meta = requestMeta(c);

  await db.transaction(async (tx) => {
    // Lock the reg row: serialize concurrent status transitions on a FRESH status (see /status). The loser
    // re-reads committed state, so the cancellable-status guard below correctly rejects a now-invalid move.
    const reg = await getRegistrationOrThrow(tx, registrationId, { forUpdate: true });
    if (reg.userId !== user.id) throw forbidden();
    const event = await getEventOrThrow(tx, reg.eventId);
    if (!event.allowStudentCancelRegistration)
      throw forbidden("Cancellation is not allowed for this event");
    if (event.cancelRegistrationCloseAt && new Date() > event.cancelRegistrationCloseAt)
      throw badRequest("cancel_closed", "Cancellation window is closed");
    if (reg.status === "checked_in")
      throw badRequest("already_checked_in", "Cannot cancel after check-in");
    if (reg.status === "cancelled") throw badRequest("already_cancelled", "Already cancelled");

    await tx
      .update(registrations)
      .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
      .where(eq(registrations.id, reg.id));
    await revokeActiveQrToken(tx, reg.id, user.id); // cancelled regs hold no active QR

    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "registration_cancelled",
        entityType: "registration",
        entityId: reg.id,
        eventId: reg.eventId,
        registrationId: reg.id,
        targetUserId: user.id,
        oldValue: { status: reg.status },
        newValue: { status: "cancelled" },
        ...meta,
      },
      tx,
    );
  });

  return c.json({ ok: true });
});

// Student edits own answers (if allowed + before deadline + not checked_in). Keeps own form version.
router.patch("/registrations/:registrationId/answers", requireAuth, async (c) => {
  const { registrationId } = regIdParam.parse(c.req.param());
  const body = answersBody.parse(await c.req.json());
  const user = c.get("user");
  const meta = requestMeta(c);

  await db.transaction(async (tx) => {
    const reg = await getRegistrationOrThrow(tx, registrationId);
    if (reg.userId !== user.id) throw forbidden();
    const event = await getEventOrThrow(tx, reg.eventId);
    if (!event.allowStudentEditRegistration)
      throw forbidden("Editing is not allowed for this event");
    if (event.editRegistrationCloseAt && new Date() > event.editRegistrationCloseAt)
      throw badRequest("edit_closed", "Edit window is closed");
    if (reg.status === "checked_in")
      throw badRequest("already_checked_in", "Cannot edit after check-in");
    if (reg.status === "cancelled")
      throw badRequest("cancelled", "Cannot edit a cancelled registration");
    if (!reg.formVersionId) throw badRequest("no_form_version", "Registration has no form version");

    const version = await getFormVersionById(tx, reg.formVersionId);
    if (!version) throw notFound("Form version not found");
    const values = validateAgainstVersion(version, body.answers);
    await writeAnswers(tx, reg.id, version.id, values);
    await tx
      .update(registrations)
      .set({ updatedAt: new Date() })
      .where(eq(registrations.id, reg.id));

    await writeAudit(
      {
        actorUserId: user.id,
        actorRole: user.role,
        action: "registration_answers_edited",
        entityType: "registration",
        entityId: reg.id,
        eventId: reg.eventId,
        registrationId: reg.id,
        targetUserId: user.id,
        ...meta,
      },
      tx,
    );
  });

  return c.json({ ok: true });
});

// Caller's registrations (incl. archived/cancelled).
router.get("/me/registrations", requireAuth, async (c) => {
  const user = c.get("user");
  const regs = await listUserRegistrationsWithEvent(user.id);
  // Enrich each bare reg row with event title/start so the student list shows which event it's for.
  return c.json({
    registrations: regs.map(({ registration, event }) => ({
      ...serializeRegistration(registration),
      eventTitle: event?.title ?? null,
      eventStartAt: event?.eventStartAt?.toISOString() ?? null,
    })),
  });
});

// Caller's registration detail + QR (if eligible) + answers + file ids.
router.get("/me/registrations/:registrationId", requireAuth, async (c) => {
  const { registrationId } = regIdParam.parse(c.req.param());
  const user = c.get("user");
  const reg = await getRegistrationOrThrow(db, registrationId);
  if (reg.userId !== user.id) throw forbidden();
  const event = await getEventOrThrow(db, reg.eventId);

  const [answers, fileIds, files] = await Promise.all([
    getAnswers(db, reg.id),
    getFileIds(db, reg.id),
    getFiles(db, reg.id),
  ]);
  // Frozen form schema for THIS reg's version → lets the student page resolve answer keys to labels
  // and the edit page render real fields. Null when the reg predates forms or schema is corrupt.
  const version = reg.formVersionId ? await getFormVersionById(db, reg.formVersionId) : null;
  let form: { schema: unknown } | null = null;
  if (version) {
    try {
      form = { schema: parseFormSchema(version) };
    } catch {
      form = null; // corrupt schema → fall back to raw keys, don't break the page
    }
  }
  const eligible = qrEligible(reg.status, event.status);
  // Owner-only: decrypt the active token so the QR encodes the real scan secret (not the event URL).
  const qrToken = eligible ? await getActiveQrTokenForOwner(db, reg.id) : null;
  const qrAvailable = eligible && qrToken != null;
  // The single QR serves both check-in and check-out. Decide which phase we're in (mirrors the scan
  // gates in checkins/routes) so the student page shows the QR only while the relevant window is open.
  const settings = await getPointSettings(db);
  const config = await getEventPointConfig(reg.eventId, db);
  const qrPhase = computeQrPhase(reg, event, config, settings, new Date(), eligible);

  return c.json({
    registration: serializeRegistration(reg),
    // Event context so the student detail page can show title/date/location + edit/cancel windows.
    event: {
      title: event.title,
      description: event.description,
      location: event.location,
      status: event.status,
      eventStartAt: event.eventStartAt?.toISOString() ?? null,
      eventEndAt: event.eventEndAt?.toISOString() ?? null,
      publicSlug: event.publicSlug,
      allowStudentCancelRegistration: event.allowStudentCancelRegistration,
      cancelRegistrationCloseAt: event.cancelRegistrationCloseAt?.toISOString() ?? null,
      allowStudentEditRegistration: event.allowStudentEditRegistration,
      editRegistrationCloseAt: event.editRegistrationCloseAt?.toISOString() ?? null,
    },
    answers,
    fileIds,
    // Rich file metadata (filename + mime) so the detail page can label downloads; fileIds kept for back-compat.
    files,
    form,
    qr: {
      eligible,
      available: qrAvailable,
      publicEventId: event.publicId,
      token: qrToken,
      // phase = which scan stage we're in; showQr = render the QR right now (token also gated on it).
      phase: qrPhase.phase,
      showQr: qrPhase.showQr && qrAvailable,
    },
  });
});

// =====================================================================
// ADMIN OVERRIDE (canManageEvents — all require reason + audit)
// =====================================================================

// List registrations for an event — enriched with user identity + checked-in-by name + form version.
// Server-side search/filter/pagination so the page scales (returns total for pagination UI).
router.get(
  "/admin/events/:eventId/registrations",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const query = adminRegListQuery.parse(c.req.query());
    await getEventOrThrow(db, eventId);
    const { rows, total } = await listEventRegistrationsForAdmin(eventId, query);
    return c.json({ registrations: rows, total, limit: query.limit, offset: query.offset });
  },
);

// User typeahead for the manual-register picker (by student_id / email / full_name).
// Excludes users already holding a non-cancelled registration for this event.
router.get(
  "/admin/events/:eventId/user-search",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const { q, limit } = userSearchQuery.parse(c.req.query());
    await getEventOrThrow(db, eventId);
    const users = await searchUsersForRegistration(eventId, q, limit);
    return c.json({ users });
  },
);

// Registration detail + answers/files + audit history.
router.get(
  "/admin/registrations/:registrationId",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const reg = await getRegistrationOrThrow(db, registrationId);
    const event = await getEventOrThrow(db, reg.eventId);
    // Identity + file metadata + active-QR state so the per-person page shows WHO it is and current QR status.
    const [answers, files, user, qrActive] = await Promise.all([
      getAnswers(db, reg.id),
      getFiles(db, reg.id),
      getRegistrationIdentity(db, reg.userId),
      hasActiveQrToken(db, reg.id),
    ]);
    const history = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.registrationId, reg.id))
      .orderBy(desc(auditLogs.createdAt));
    // Resolve the check-in/out actor names so the admin state-override panel shows WHO stamped each
    // (not a raw UUID). Null when no actor recorded (e.g. legacy or never-stamped).
    const checkedInBy = reg.checkedInByUserId ? await getUserName(db, reg.checkedInByUserId) : null;
    const checkedOutBy = reg.checkedOutByUserId ? await getUserName(db, reg.checkedOutByUserId) : null;
    return c.json({
      registration: {
        ...serializeRegistration(reg),
        checkedInBy, // staff/admin display name (state-override panel)
        checkedOutBy,
      },
      user, // { userId, studentId, fullName, email, faculty, department }
      answers,
      files, // [{ id, filename, mimeType }]
      fileIds: files.map((f) => f.id), // kept for backward compatibility
      qr: { eligible: qrEligible(reg.status, event.status), active: qrActive },
      auditHistory: history,
    });
  },
);

// Manual register (override window/capacity). Over-capacity → audit admin_register_over_capacity.
router.post(
  "/admin/events/:eventId/registrations",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const body = adminRegisterBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    const result = await db.transaction(async (tx) => {
      const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update").limit(1);
      if (!event) throw notFound("Event not found");

      const [existing] = await tx
        .select()
        .from(registrations)
        .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, body.userId)))
        .limit(1);
      if (existing && existing.status !== "cancelled")
        throw conflict("already_registered", "User already has a registration for this event");

      const version = await getActiveFormVersion(tx, eventId);
      if (!version) throw badRequest("no_active_form", "Event has no active form version");
      // Manual register: relax required-file fields (no registration yet to attach a file to).
      const values = validateAgainstVersion(version, body.answers, {
        allowMissingRequiredFiles: true,
      });

      const count = await countActiveRegistrations(tx, eventId);
      const overCapacity =
        event.capacityEnabled && event.capacityLimit != null && count >= event.capacityLimit;

      const now = new Date();
      const reg = existing
        ? await reactivate(tx, existing.id, "registered", version.id, now)
        : await insertReg(tx, eventId, body.userId, "registered", version.id, now);
      await writeAnswers(tx, reg.id, version.id, values);
      const qrToken = await issueQrToken(tx, reg.id, admin.id);

      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "registration_created",
          entityType: "registration",
          entityId: reg.id,
          eventId,
          registrationId: reg.id,
          targetUserId: body.userId,
          newValue: { status: "registered", manual: true },
          reason: body.reason,
          ...meta,
        },
        tx,
      );
      if (overCapacity) {
        await writeAudit(
          {
            actorUserId: admin.id,
            actorRole: admin.role,
            action: "admin_register_over_capacity",
            entityType: "registration",
            entityId: reg.id,
            eventId,
            registrationId: reg.id,
            targetUserId: body.userId,
            metadata: { count, limit: event.capacityLimit },
            reason: body.reason,
            ...meta,
          },
          tx,
        );
      }
      return { reg, qrToken };
    });

    return c.json({ registration: serializeRegistration(result.reg), qrToken: result.qrToken }, 201);
  },
);

// Admin cancel (reason + audit).
router.post(
  "/admin/registrations/:registrationId/cancel",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const { reason } = reasonBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    await db.transaction(async (tx) => {
      const reg = await getRegistrationOrThrow(tx, registrationId);
      if (reg.status === "cancelled") throw badRequest("already_cancelled", "Already cancelled");
      await tx
        .update(registrations)
        .set({ status: "cancelled", cancelledAt: new Date(), updatedAt: new Date() })
        .where(eq(registrations.id, reg.id));
      await revokeActiveQrToken(tx, reg.id, admin.id);
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "registration_cancelled",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { status: reg.status },
          newValue: { status: "cancelled" },
          reason,
          ...meta,
        },
        tx,
      );
    });
    return c.json({ ok: true });
  },
);

// Promote waitlisted → registered (reason + audit). Issues QR.
router.post(
  "/admin/registrations/:registrationId/promote",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const { reason } = reasonBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    const out = await db.transaction(async (tx) => {
      // Lock the reg row: serialize concurrent status transitions on a FRESH status (see /status). The loser
      // re-reads committed state, so the waitlisted guard rejects a promote on an already-changed reg.
      const reg = await getRegistrationOrThrow(tx, registrationId, { forUpdate: true });
      if (reg.status !== "waitlisted")
        throw badRequest("not_waitlisted", "Only waitlisted registrations can be promoted");
      await tx
        .update(registrations)
        .set({ status: "registered", registeredAt: new Date(), updatedAt: new Date() })
        .where(eq(registrations.id, reg.id));
      const qrToken = await issueQrToken(tx, reg.id, admin.id);
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "registration_promoted",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { status: "waitlisted" },
          newValue: { status: "registered" },
          reason,
          ...meta,
        },
        tx,
      );
      return { qrToken };
    });
    return c.json({ ok: true, qrToken: out.qrToken });
  },
);

// Demote registered → waitlisted (reason + audit). Revokes QR.
router.post(
  "/admin/registrations/:registrationId/demote",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const { reason } = reasonBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    await db.transaction(async (tx) => {
      // Lock the reg row: serialize concurrent status transitions on a FRESH status (see /status). The loser
      // re-reads committed state, so the registered guard rejects a demote on an already-changed reg.
      const reg = await getRegistrationOrThrow(tx, registrationId, { forUpdate: true });
      if (reg.status !== "registered")
        throw badRequest("not_registered", "Only registered registrations can be demoted");
      await tx
        .update(registrations)
        .set({ status: "waitlisted", waitlistedAt: new Date(), updatedAt: new Date() })
        .where(eq(registrations.id, reg.id));
      await revokeActiveQrToken(tx, reg.id, admin.id);
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "registration_demoted",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { status: "registered" },
          newValue: { status: "waitlisted" },
          reason,
          ...meta,
        },
        tx,
      );
    });
    return c.json({ ok: true });
  },
);

// Admin override: set the registration status directly (reason + audit). Unified replacement for the
// promote/demote/cancel/manual-checkin transitions — applies the right side-effects per target:
//   active (registered/checked_in)  → issue QR if none; capacity-audit when entering from inactive
//   inactive (waitlisted/cancelled) → revoke active QR
//   leaving checked_in              → clear check-in/out stamps + reverse any awarded points
// Intentionally does NOT gate on the check-in window/published (this is an explicit admin override).
router.post(
  "/admin/registrations/:registrationId/status",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const { status: target, reason, awardPoints } = statusChangeBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    await db.transaction(async (tx) => {
      // Lock the registration row (not just the event): concurrent admin status-changes must serialize on a
      // FRESH status, else the loser proceeds on a stale snapshot → stamp clobber + duplicate audit row.
      const [reg] = await tx.select().from(registrations).where(eq(registrations.id, registrationId)).for("update").limit(1);
      if (!reg) throw notFound("Registration not found");
      // Lock the event row so the capacity count is race-safe when entering an active status.
      const [event] = await tx.select().from(events).where(eq(events.id, reg.eventId)).for("update").limit(1);
      if (!event) throw notFound("Event not found");
      if (reg.status === target) throw badRequest("status_unchanged", "Registration already has this status");

      const now = new Date();
      const wasActive = reg.status === "registered" || reg.status === "checked_in";
      const willBeActive = target === "registered" || target === "checked_in";

      // Capacity: only when entering an active status from a non-active one. Admin may exceed it; we audit.
      let count = 0;
      let overCapacity = false;
      if (willBeActive && !wasActive && event.capacityEnabled && event.capacityLimit != null) {
        count = await countActiveRegistrations(tx, reg.eventId);
        overCapacity = count >= event.capacityLimit;
      }

      // Leaving checked_in → reverse any awarded check-in/out points (idempotent; no-op if none).
      const leavingCheckedIn = reg.status === "checked_in" && target !== "checked_in";
      let pointsReversed = false;
      if (leavingCheckedIn) {
        const rev = await reverseCheckinOnUndo(tx, {
          registrationId: reg.id,
          studentUserId: reg.userId,
          undoneByUserId: admin.id,
          reason,
        });
        pointsReversed = rev.reversed;
      }

      // Build the status-specific patch (timestamps mirror the dedicated transition endpoints).
      const patch: Record<string, unknown> = { status: target, updatedAt: now };
      if (leavingCheckedIn) {
        patch.checkedInAt = null;
        patch.checkedInByUserId = null;
        patch.checkinMethod = null;
        patch.checkedOutAt = null;
        patch.checkedOutByUserId = null;
        patch.manualCheckinReason = null; // drop stale reason so it can't leak into a later checked_in state
      }
      if (reg.status === "cancelled" && target !== "cancelled") patch.cancelledAt = null; // re-activate clears it
      if (target === "registered") patch.registeredAt = reg.registeredAt ?? now;
      if (target === "waitlisted") patch.waitlistedAt = now;
      if (target === "cancelled") patch.cancelledAt = now;
      if (target === "checked_in") {
        patch.checkedInAt = now;
        patch.checkedInByUserId = admin.id;
        patch.checkinMethod = "admin_override"; // admin force-set status, not a scan/search — distinct in reports
        patch.manualCheckinReason = reason;
      }
      await tx.update(registrations).set(patch).where(eq(registrations.id, reg.id));

      // Entering checked_in awards checkin_in by default (mirrors QR/manual scan), unless admin opted out.
      // Same epoch-aware path as the scan flows; awardCheckinIn guards student-only + toggle + cutoff inside.
      const enteringCheckedIn = target === "checked_in" && reg.status !== "checked_in";
      let pointsAwarded = 0;
      if (enteringCheckedIn && awardPoints) {
        const [u] = await tx
          .select({ role: users.role })
          .from(users)
          .where(eq(users.id, reg.userId))
          .limit(1);
        const award = await awardCheckinIn(tx, {
          eventId: reg.eventId,
          registrationId: reg.id,
          studentUserId: reg.userId,
          studentRole: u?.role ?? "student",
          scannedByUserId: admin.id,
          eventTitle: event.title,
          scanMethod: "admin_override",
        });
        pointsAwarded = award.pointsAwarded;
      }

      // QR follows status: active → ensure a token exists; inactive → revoke any active token.
      if (willBeActive) {
        if (!(await hasActiveQrToken(tx, reg.id))) await issueQrToken(tx, reg.id, admin.id);
      } else {
        await revokeActiveQrToken(tx, reg.id, admin.id);
      }

      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "registration_status_changed",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { status: reg.status },
          newValue: { status: target, pointsReversed, pointsAwarded },
          reason,
          ...meta,
        },
        tx,
      );
      if (overCapacity) {
        await writeAudit(
          {
            actorUserId: admin.id,
            actorRole: admin.role,
            action: "admin_register_over_capacity",
            entityType: "registration",
            entityId: reg.id,
            eventId: reg.eventId,
            registrationId: reg.id,
            targetUserId: reg.userId,
            metadata: { count, limit: event.capacityLimit },
            reason,
            ...meta,
          },
          tx,
        );
      }
    });
    return c.json({ ok: true });
  },
);

// Admin edit answers (reason + audit). Uses registration's own form version.
router.patch(
  "/admin/registrations/:registrationId/answers",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const body = adminAnswersBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    await db.transaction(async (tx) => {
      const reg = await getRegistrationOrThrow(tx, registrationId);
      if (!reg.formVersionId)
        throw badRequest("no_form_version", "Registration has no form version");
      const version = await getFormVersionById(tx, reg.formVersionId);
      if (!version) throw notFound("Form version not found");
      const oldAnswers = await getAnswers(tx, reg.id);
      const values = validateAgainstVersion(version, body.answers);
      await writeAnswers(tx, reg.id, version.id, values);
      await tx
        .update(registrations)
        .set({ updatedAt: new Date() })
        .where(eq(registrations.id, reg.id));
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "admin_edit_registration_answer",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: oldAnswers,
          newValue: values,
          reason: body.reason,
          ...meta,
        },
        tx,
      );
    });
    return c.json({ ok: true });
  },
);

// Regenerate QR — revoke old active + issue new (reason + audit). Returns plaintext once.
router.post(
  "/admin/registrations/:registrationId/qr/regenerate",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const { reason } = reasonBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    const out = await db.transaction(async (tx) => {
      const reg = await getRegistrationOrThrow(tx, registrationId);
      if (reg.status === "cancelled" || reg.status === "waitlisted")
        throw badRequest("qr_not_eligible", "Registration is not eligible for a QR token");
      const qrToken = await issueQrToken(tx, reg.id, admin.id);
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "qr_regenerated",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          reason,
          ...meta,
        },
        tx,
      );
      return { qrToken };
    });
    return c.json({ qrToken: out.qrToken });
  },
);

// Revoke active QR (reason + audit).
router.post(
  "/admin/registrations/:registrationId/qr/revoke",
  requireAuth,
  requirePermission(canManageEvents),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const { reason } = reasonBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);

    await db.transaction(async (tx) => {
      const reg = await getRegistrationOrThrow(tx, registrationId);
      const revoked = await revokeActiveQrToken(tx, reg.id, admin.id);
      if (!revoked) throw badRequest("no_active_token", "No active QR token to revoke");
      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "qr_revoked",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          reason,
          ...meta,
        },
        tx,
      );
    });
    return c.json({ ok: true });
  },
);

export default router;

// ---- local helpers (kept below routes to keep handlers readable) ----

// Resolve a user's display name by id (for check-in/out actor labels). Null when missing.
async function getUserName(exec: typeof db | Tx, userId: string): Promise<string | null> {
  const [u] = await exec.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.fullName ?? null;
}

// Insert a fresh registration with the right status timestamp set.
async function insertReg(
  tx: Tx,
  eventId: string,
  userId: string,
  status: "registered" | "waitlisted",
  formVersionId: string,
  now: Date,
) {
  const [reg] = await tx
    .insert(registrations)
    .values({
      eventId,
      userId,
      status,
      formVersionId,
      registeredAt: status === "registered" ? now : null,
      waitlistedAt: status === "waitlisted" ? now : null,
    })
    .returning();
  if (!reg) throw new Error("registration insert returned no row");
  return reg;
}

// Re-activate a previously cancelled registration (cancelled→registered/waitlisted).
async function reactivate(
  tx: Tx,
  id: string,
  status: "registered" | "waitlisted",
  formVersionId: string,
  now: Date,
) {
  const [reg] = await tx
    .update(registrations)
    .set({
      status,
      formVersionId,
      cancelledAt: null,
      registeredAt: status === "registered" ? now : null,
      waitlistedAt: status === "waitlisted" ? now : null,
      updatedAt: now,
    })
    .where(eq(registrations.id, id))
    .returning();
  if (!reg) throw new Error("registration update returned no row");
  return reg;
}
