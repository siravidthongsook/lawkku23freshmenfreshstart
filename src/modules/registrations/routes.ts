import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db, type Tx } from "../../db/client";
import { events } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { auditLogs } from "../../db/schema/audit";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canManageEvents } from "../../lib/permissions";
import { badRequest, conflict, forbidden, notFound } from "../../lib/errors";
import { writeAudit } from "../../lib/audit";
import { isWithinWindow } from "../../lib/time";
import { issueQrToken, revokeActiveQrToken, hasActiveQrToken } from "../qr-tokens/service";
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
  log.set("eventId", eventId);

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
    else throw conflict("registration_full", "Event is full");

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
    const reg = await getRegistrationOrThrow(tx, registrationId);
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
  const qrAvailable = eligible && (await hasActiveQrToken(db, reg.id));

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
    qr: { eligible, available: qrAvailable, publicEventId: event.publicId },
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
    return c.json({
      registration: serializeRegistration(reg),
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
      const reg = await getRegistrationOrThrow(tx, registrationId);
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
      const reg = await getRegistrationOrThrow(tx, registrationId);
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
