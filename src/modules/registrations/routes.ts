import { Hono } from "hono";
import { and, desc, eq, or } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db, type Tx } from "../../db/client";
import { events } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { users } from "../../db/schema/users";
import { auditLogs } from "../../db/schema/audit";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canManageEvents, canWalkinRegister } from "../../lib/permissions";
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
import { awardCheckinIn, getActiveCheckinPoints, reverseCheckinOnUndo } from "../points/checkin-award";
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
  // Origin recorded on the reg. Default "normal"; admin can record a real gate walk-in for an existing user.
  source: z.enum(["normal", "walkin"]).default("normal"),
});
const adminAnswersBody = answersBody.extend({ reason: z.string().min(1) });

// ---- Walk-in register (gate flow) — request + response contract, exported for @be/* frontend import ----
// Creates a brand-new no-account student (CLAIM mode: passwordHash=null, student claims later via student_id)
// + registers them + optionally checks them in, all in one tx. Staff/admin only (canWalkinRegister).
export const walkinRegisterBody = z.object({
  // Optional: only REQUIRED when creating a brand-new account (guarded in handler). Ignored on the reuse path.
  full_name: z.string().trim().min(1).optional(),
  student_id: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().email().optional(), // normalize -> case-insensitive dup check
  faculty: z.string().trim().optional(),
  department: z.string().trim().optional(),
  phone: z.string().trim().optional(),
  nickname: z.string().trim().optional(),
  year: z.coerce.number().int().optional(),
  group_number: z.coerce.number().int().min(1).optional(), // บรรพ — any positive cohort #; staff-assigned label, not a claim factor (no upper cap)
  answers: z.record(z.string(), z.unknown()).default({}),
  // Provenance of the registration. Admin desk can choose; staff gate always sends "walkin".
  // Default "walkin" keeps existing callers/behavior unchanged.
  source: z.enum(["normal", "walkin"]).default("walkin"),
  checkin_now: z.boolean().default(true), // stamp check-in now (even if the window is closed — gate override)
  // Two-step confirm: a real run that REUSES an existing account requires confirm_reuse=true.
  // Without it → 409 user_exists, forcing the dry_run preview round-trip first (guards against wrong-person).
  confirm_reuse: z.boolean().default(false),
  reason: z.string().min(1), // audited on user_created + registration_created
  dry_run: z.boolean().default(false), // preview-only: full validation, NO mutation
});
export type WalkinRegisterBody = z.infer<typeof walkinRegisterBody>;

// Public user shape returned by the walk-in endpoint (subset of users.publicUser; no secrets).
const walkinPublicUser = z.object({
  id: z.string().uuid(),
  email: z.string().nullable(),
  student_id: z.string().nullable(),
  role: z.string(),
  full_name: z.string(),
  faculty: z.string().nullable(),
  department: z.string().nullable(),
  phone: z.string().nullable(),
  nickname: z.string().nullable(),
  year: z.number().nullable(),
  group_number: z.number().nullable(),
  status: z.string(),
  claimed: z.boolean(), // false here — claim account not yet self-claimed
  created_at: z.string(),
});

// Legacy skip reason. Retained for back-compat only — the check-in stamp now always happens (even past a
// closed window), so this is never set for the closed-window case anymore. See pastWindow instead.
const walkinCheckinSkipped = z.enum(["checkin_not_open", "checkin_closed"]);

export const walkinRegisterResponse = z.object({
  user: walkinPublicUser,
  registration: z.record(z.string(), z.unknown()), // serializeRegistration shape (incl. registrationSource)
  qrToken: z.string().nullable(), // plaintext, returned ONCE (null on dry_run AND on any reuse — stored hashed)
  checkedIn: z.boolean(),
  checkinSkipped: walkinCheckinSkipped.optional(), // back-compat only; no longer set for closed-window
  pointsAwarded: z.number(),
  // Whether an existing account was matched + the state of its reg for this event (drives the confirm dialog).
  // New-user path → { found:false, existingRegStatus:"none" }.
  matchedExisting: z.object({
    found: z.boolean(),
    existingRegStatus: z.enum(["none", "registered", "checked_in", "cancelled", "waitlisted"]),
  }),
  pastWindow: z.boolean(), // true when the check-in stamp happened OUTSIDE the open window (gate override)
  dryRun: z.boolean(), // true = nothing was persisted (preview only)
});
export type WalkinRegisterResponse = z.infer<typeof walkinRegisterResponse>;

// ---- Walk-in lookup (gate pre-check) — GET /events/:eventId/walkin/lookup ----
// EXACT-match (student_id OR email) read-only probe so the gate can decide reuse-vs-create before committing.
// EXACT only (no LIKE) to avoid user enumeration. No user id in the response — FE doesn't need it.
const walkinLookupQuery = z.object({
  student_id: z.string().trim().min(1),
  email: z.string().trim().toLowerCase().email().optional(),
});
export const walkinLookupResponse = z.object({
  found: z.boolean(),
  eligible: z.boolean(), // found && role==="student" && status==="active"
  ineligibleReason: z.enum(["not_student", "inactive"]).nullable(), // set when found && !eligible
  user: z
    .object({
      full_name: z.string(),
      student_id: z.string().nullable(),
      email: z.string().nullable(),
      faculty: z.string().nullable(),
      department: z.string().nullable(),
      nickname: z.string().nullable(),
      year: z.number().nullable(),
      group_number: z.number().nullable(),
      role: z.string(),
      status: z.string(),
    })
    .nullable(), // null when not found
  existingRegStatus: z.enum(["none", "registered", "checked_in", "cancelled", "waitlisted"]),
});
export type WalkinLookupResponse = z.infer<typeof walkinLookupResponse>;

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
    // Active points per leg so the panel can warn "clearing this stamp also removes N points".
    const checkinPoints = await getActiveCheckinPoints(db, reg.id);
    return c.json({
      registration: {
        ...serializeRegistration(reg),
        checkedInBy, // staff/admin display name (state-override panel)
        checkedOutBy,
        checkinInPoints: checkinPoints.checkinIn, // active checkin_in award (null = none)
        checkinOutPoints: checkinPoints.checkinOut,
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
        ? await reactivate(tx, existing.id, "registered", version.id, now, { source: body.source })
        : await insertReg(tx, eventId, body.userId, "registered", version.id, now, { source: body.source });
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

// =====================================================================
// WALK-IN REGISTER (gate flow — staff/admin)
// =====================================================================

// Pre-check probe: EXACT-match a user by student_id OR email (same condition as the walk-in dup-guard),
// so the gate UI can decide reuse-vs-create + warn on ineligible/already-registered before committing.
// Read-only — no writes, no tx. EXACT only (never partial) to avoid user enumeration.
router.get(
  "/events/:eventId/walkin/lookup",
  requireAuth,
  requirePermission(canWalkinRegister),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const { student_id, email } = walkinLookupQuery.parse(c.req.query());

    // Event must exist (minimal check — mirrors the POST's existence guard; unpublished not re-checked here).
    const [event] = await db.select({ id: events.id }).from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw notFound("Event not found");

    const conds = [eq(users.studentId, student_id)];
    if (email) conds.push(eq(users.email, email));
    const [u] = await db.select().from(users).where(or(...conds)).limit(1);

    if (!u) {
      const res: WalkinLookupResponse = {
        found: false,
        eligible: false,
        ineligibleReason: null,
        user: null,
        existingRegStatus: "none",
      };
      return c.json(res);
    }

    // Eligibility for walk-in: only an ACTIVE student can be registered as a participant.
    // not_student wins when both apply (it's the harder block — never silently walk-in a privileged account).
    const ineligibleReason: WalkinLookupResponse["ineligibleReason"] =
      u.role !== "student" ? "not_student" : u.status !== "active" ? "inactive" : null;
    const eligible = ineligibleReason === null;

    // Resolve any existing reg for this (event, user) so the UI can warn "already registered/checked in".
    const [existingReg] = await db
      .select({ status: registrations.status })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, u.id)))
      .limit(1);

    const res: WalkinLookupResponse = {
      found: true,
      eligible,
      ineligibleReason,
      user: {
        full_name: u.fullName,
        student_id: u.studentId,
        email: u.email,
        faculty: u.faculty,
        department: u.department,
        nickname: u.nickname,
        year: u.year,
        group_number: u.groupNumber,
        role: u.role,
        status: u.status,
      },
      existingRegStatus: (existingReg?.status ?? "none") as WalkinLookupResponse["existingRegStatus"],
    };
    return c.json(res);
  },
);

// Create a brand-new no-account student + register them + optionally check them in, in ONE tx.
// CLAIM mode: passwordHash=null, passwordMustChange=false — student claims later via /auth/claim (student_id).
// Form answers are FULLY RELAXED (allowMissingRequired). checkin_now with a CLOSED window does NOT fail the
// tx — it creates the user+reg and returns checkinSkipped so the gate can still capture the walk-in.
router.post(
  "/events/:eventId/walkin",
  requireAuth,
  requirePermission(canWalkinRegister),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const body = walkinRegisterBody.parse(await c.req.json());
    const actor = c.get("user");
    const meta = requestMeta(c);
    const log = c.get("log");
    log.set("action", "registration.walkin").set("eventId", eventId);

    const result = await db.transaction(async (tx) => {
      // Lock the event row (race-safe capacity read + serialize concurrent gate creates on this event).
      const [event] = await tx.select().from(events).where(eq(events.id, eventId)).for("update").limit(1);
      if (!event) throw notFound("Event not found");
      if (event.status !== "published")
        throw badRequest("event_not_published", "Event is not published");

      // Resolve-or-create: a user already on file with this student_id (or email) is REUSED (no new account,
      // no profile overwrite) instead of 409. Select the FULL row — we need role + profile for the preview.
      const dupConds = [eq(users.studentId, body.student_id)];
      if (body.email) dupConds.push(eq(users.email, body.email));
      const [dupUser] = await tx
        .select()
        .from(users)
        .where(or(...dupConds))
        .limit(1);
      if (dupUser) {
        // Never walk-in a privileged account as a participant (data-about-the-target guard, not actor perm).
        if (dupUser.role !== "student")
          throw conflict("cannot_walkin_privileged", "Cannot walk-in a non-student (admin/staff) account");
        if (dupUser.status !== "active")
          throw conflict("user_inactive", "User account is not active — escalate to admin");
        // Two-step confirm: a real reuse must carry confirm_reuse=true (set after the dry_run preview).
        if (!body.dry_run && !body.confirm_reuse)
          throw conflict(
            "user_exists",
            "A user with this student ID or email already exists — search for them and check them in instead",
          );
      }
      const reuse = dupUser != null; // reuse existing account (no insert, no profile overwrite, no user_created audit)

      // full_name is optional on the wire but REQUIRED to mint a new account (reuse never overwrites the profile,
      // so it's ignored there). Fire on dry_run too so the preview surfaces the missing-name error up-front.
      if (!reuse && !body.full_name)
        throw badRequest("full_name_required", "ชื่อ-นามสกุลจำเป็นสำหรับบัญชีใหม่");

      const version = await getActiveFormVersion(tx, eventId);
      if (!version) throw badRequest("no_active_form", "Event has no active form version");
      // Walk-in: relax ALL required fields (gate captures minimal data; form filled later).
      const values = validateAgainstVersion(version, body.answers, {
        allowMissingRequired: true,
        allowMissingRequiredFiles: true,
      });

      const now = new Date();
      // Compute the check-in window state up-front (for honesty/preview only — the stamp now ALWAYS happens
      // when checkin_now is set, even past a closed window; windowOpen just flags whether it's an override).
      const checkinClose = effectiveCheckinClose(event.checkinCloseAt, event.eventEndAt);
      const windowOpen =
        !(event.checkinOpenAt && now < event.checkinOpenAt) && !(checkinClose && now > checkinClose);
      const pastWindow = body.checkin_now && !windowOpen; // stamp will happen outside the open window (gate override)

      // Existing reg for (event, reused user) — an on-file account may already have a reg (unique(event,user)).
      // Only meaningful when reusing; a brand-new user can't have one. (SELECT is safe inside the rolled-back dry_run tx.)
      const existingReg = reuse
        ? (
            await tx
              .select()
              .from(registrations)
              .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, dupUser!.id)))
              .limit(1)
          )[0]
        : undefined;
      const existingRegStatus = (existingReg?.status ?? "none") as
        | "none"
        | "registered"
        | "checked_in"
        | "cancelled"
        | "waitlisted";

      // Capacity is READ but never blocks (mirrors admin manual register — audit over-capacity, never reject).
      const count = await countActiveRegistrations(tx, eventId);
      const overCapacity =
        event.capacityEnabled && event.capacityLimit != null && count >= event.capacityLimit;

      // ----- dry_run: full validation + resolve + window state done above; preview WITHOUT mutating. -----
      if (body.dry_run) {
        // Reused account → show its REAL profile (we never overwrite). New account → echo the typed values.
        const previewUser: WalkinRegisterResponse["user"] = reuse
          ? serializeWalkinUser(dupUser!)
          : {
              id: "00000000-0000-0000-0000-000000000000", // placeholder — no row created on dry_run
              email: body.email ?? null,
              student_id: body.student_id,
              role: "student",
              full_name: body.full_name!, // guaranteed present on new-user path (full_name_required guard above)
              faculty: body.faculty ?? null,
              department: body.department ?? null,
              phone: body.phone ?? null,
              nickname: body.nickname ?? null,
              year: body.year ?? null,
              group_number: body.group_number ?? null,
              status: "active",
              claimed: false,
              created_at: now.toISOString(),
            };
        // Roll back so nothing is written (no user, no reg, no audit).
        throw new WalkinDryRunResult({
          user: previewUser,
          registration: {
            eventId,
            status: body.checkin_now ? "checked_in" : "registered", // stamp always happens now
            registrationSource: existingReg?.registrationSource ?? body.source,
          },
          qrToken: null,
          checkedIn: body.checkin_now,
          pointsAwarded: 0, // preview can't compute the real award without writing; 0 is a safe hint
          matchedExisting: { found: reuse, existingRegStatus },
          pastWindow,
          dryRun: true,
        });
      }

      // ----- real run: resolve user (reuse-or-create CLAIM mode), resolve reg, optionally check in. -----
      let target: typeof users.$inferSelect;
      if (reuse) {
        // Reuse the existing account verbatim — no profile overwrite, no user_created audit.
        target = dupUser!;
      } else {
        // The pre-check above is a fast path; two concurrent same-student_id walk-ins can both pass it,
        // so the second insert hits the users unique constraint (student_id/email). Catch 23505 and
        // re-throw as a clean 409 user_exists instead of letting it scrub to a 500.
        const created = await tx
          .insert(users)
          .values({
            email: body.email ?? null,
            studentId: body.student_id,
            role: "student",
            status: "active",
            fullName: body.full_name!, // guaranteed present on new-user path (full_name_required guard above)
            faculty: body.faculty ?? null,
            department: body.department ?? null,
            phone: body.phone ?? null,
            nickname: body.nickname ?? null,
            year: body.year ?? null,
            groupNumber: body.group_number ?? null, // บรรพ — staff-assigned at walk-in
            passwordHash: null, // CLAIM mode — student self-claims later via student_id
            passwordMustChange: false,
            createdByAdminId: actor.id,
          })
          .returning()
          .then(([row]) => row)
          .catch((e: unknown) => {
            if (isUniqueViolation(e))
              throw conflict(
                "user_exists",
                "A user with this student ID or email already exists — search for them and check them in instead",
              );
            throw e;
          });
        if (!created) throw new Error("walk-in user insert returned no row");
        target = created;

        await writeAudit(
          {
            actorUserId: actor.id,
            actorRole: actor.role,
            action: "user_created",
            entityType: "user",
            entityId: created.id,
            targetUserId: created.id,
            newValue: {
              email: created.email,
              student_id: created.studentId,
              role: created.role,
              group_number: created.groupNumber,
              provision_mode: "claim",
              walkin: true,
            },
            reason: body.reason,
            ...meta,
          },
          tx,
        );
      }

      // Resolve-or-create the registration. unique(event,user) → a reused account may already have a reg.
      let reg: typeof registrations.$inferSelect;
      let qrToken: string | null = null; // plaintext returned ONLY for a freshly issued token (existing QR is hashed)
      if (!existingReg) {
        // No reg yet → create fresh (answers + QR + audit) for both new and reused accounts.
        reg = await insertReg(tx, eventId, target.id, "registered", version.id, now, {
          source: body.source, // desk can pick normal/walkin; gate sends walkin
        });
        await writeAnswers(tx, reg.id, version.id, values);
        qrToken = await issueQrToken(tx, reg.id, actor.id);

        await writeAudit(
          {
            actorUserId: actor.id,
            actorRole: actor.role,
            action: "registration_created",
            entityType: "registration",
            entityId: reg.id,
            eventId,
            registrationId: reg.id,
            targetUserId: target.id,
            newValue: { status: "registered", walkin: true },
            reason: body.reason,
            ...meta,
          },
          tx,
        );
        if (overCapacity) {
          await writeAudit(
            {
              actorUserId: actor.id,
              actorRole: actor.role,
              action: "admin_register_over_capacity",
              entityType: "registration",
              entityId: reg.id,
              eventId,
              registrationId: reg.id,
              targetUserId: target.id,
              metadata: { count, limit: event.capacityLimit, walkin: true },
              reason: body.reason,
              ...meta,
            },
            tx,
          );
        }
      } else if (existingReg.status === "cancelled" || existingReg.status === "waitlisted") {
        // Revive a cancelled/waitlisted reg → registered. Preserve answers/QR/source (don't rewrite).
        reg = await reactivate(tx, existingReg.id, "registered", existingReg.formVersionId ?? version.id, now);
        await writeAudit(
          {
            actorUserId: actor.id,
            actorRole: actor.role,
            action: "registration_status_changed",
            entityType: "registration",
            entityId: reg.id,
            eventId,
            registrationId: reg.id,
            targetUserId: target.id,
            oldValue: { status: existingReg.status },
            newValue: { status: "registered" },
            metadata: { walkin: true, revived: true },
            reason: body.reason,
            ...meta,
          },
          tx,
        );
      } else {
        // Already registered/checked_in → reuse as-is (no answers rewrite, no new QR).
        reg = existingReg;
      }

      // Optional check-in — stamps NOW regardless of window (gate override; pastWindow flags it). Idempotent.
      let checkedIn = false;
      let pointsAwarded = 0;
      let finalReg = reg;
      if (body.checkin_now) {
        if (reg.checkedInAt) {
          // Already checked in → idempotent: no re-stamp, no re-award (mirrors already_checked_in).
          checkedIn = true;
        } else {
          const [stamped] = await tx
            .update(registrations)
            .set({
              status: "checked_in",
              checkedInAt: now,
              checkedInByUserId: actor.id,
              checkinMethod: "walkin",
              manualCheckinReason: null,
              updatedAt: now,
            })
            .where(eq(registrations.id, reg.id))
            .returning();
          if (stamped) finalReg = stamped;
          checkedIn = true;

          // Award checkin_in (student/toggle/cutoff self-guarded inside; past cutoff → 0 pts but stamp stays).
          const award = await awardCheckinIn(tx, {
            eventId,
            registrationId: reg.id,
            studentUserId: target.id,
            studentRole: target.role,
            scannedByUserId: actor.id,
            eventTitle: event.title,
            scanMethod: "walkin", // honest provenance — gate walk-in, not a search/scan
          });
          pointsAwarded = award.pointsAwarded;

          await writeAudit(
            {
              actorUserId: actor.id,
              actorRole: actor.role,
              action: "manual_checkin",
              entityType: "registration",
              entityId: reg.id,
              eventId,
              registrationId: reg.id,
              targetUserId: target.id,
              oldValue: { status: reg.status },
              newValue: {
                status: "checked_in",
                method: "walkin",
                pointsAwarded: award.pointsAwarded,
                past_window: pastWindow, // gate override audit trail
              },
              reason: body.reason,
              ...meta,
            },
            tx,
          );
        }
      }

      return {
        user: serializeWalkinUser(target),
        registration: serializeRegistration(finalReg),
        qrToken,
        checkedIn,
        checkinSkipped: undefined, // closed-window no longer skips — stamp always happens
        pointsAwarded,
        matchedExisting: { found: reuse, existingRegStatus },
        pastWindow,
        dryRun: false,
      };
    }).catch((e) => {
      // dry_run unwinds the tx via a thrown sentinel so nothing is persisted — recover the preview payload here.
      if (e instanceof WalkinDryRunResult) return e.payload;
      throw e;
    });

    log.set("outcome", result.dryRun ? "walkin_dry_run" : result.checkedIn ? "walkin_checked_in" : "walkin_registered");
    return c.json(result, result.dryRun ? 200 : 201);
  },
);

export default router;

// ---- local helpers (kept below routes to keep handlers readable) ----

// Sentinel thrown to roll back the walk-in tx on dry_run (so the preview writes nothing). Caught right
// after the transaction() call; carries the preview payload back out.
class WalkinDryRunResult {
  constructor(public payload: WalkinRegisterResponse) {}
}

// Postgres unique-constraint violation (SQLSTATE 23505). Used to turn a race-lost dup insert into a 409.
function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "23505";
}

// Serialize a freshly-created walk-in user into the response shape (subset of users.publicUser; no secrets).
function serializeWalkinUser(u: typeof users.$inferSelect): WalkinRegisterResponse["user"] {
  return {
    id: u.id,
    email: u.email,
    student_id: u.studentId,
    role: u.role,
    full_name: u.fullName,
    faculty: u.faculty,
    department: u.department,
    phone: u.phone,
    nickname: u.nickname,
    year: u.year,
    group_number: u.groupNumber,
    status: u.status,
    claimed: u.passwordHash !== null, // false for a fresh claim account
    created_at: u.createdAt.toISOString(),
  };
}

// Resolve a user's display name by id (for check-in/out actor labels). Null when missing.
async function getUserName(exec: typeof db | Tx, userId: string): Promise<string | null> {
  const [u] = await exec.select({ fullName: users.fullName }).from(users).where(eq(users.id, userId)).limit(1);
  return u?.fullName ?? null;
}

// Insert a fresh registration with the right status timestamp set.
// `opts.source` records the reg origin (default "normal"; walk-in passes "walkin").
async function insertReg(
  tx: Tx,
  eventId: string,
  userId: string,
  status: "registered" | "waitlisted",
  formVersionId: string,
  now: Date,
  opts?: { source?: "normal" | "walkin" },
) {
  const [reg] = await tx
    .insert(registrations)
    .values({
      eventId,
      userId,
      status,
      registrationSource: opts?.source ?? "normal",
      formVersionId,
      registeredAt: status === "registered" ? now : null,
      waitlistedAt: status === "waitlisted" ? now : null,
    })
    .returning();
  if (!reg) throw new Error("registration insert returned no row");
  return reg;
}

// Re-activate a previously cancelled registration (cancelled→registered/waitlisted).
// `opts.source` overwrites the origin ONLY when explicitly provided; otherwise the existing
// registration_source is preserved (so reviving a "walkin" reg doesn't silently reset it to "normal").
async function reactivate(
  tx: Tx,
  id: string,
  status: "registered" | "waitlisted",
  formVersionId: string,
  now: Date,
  opts?: { source?: "normal" | "walkin" },
) {
  const patch: Record<string, unknown> = {
    status,
    formVersionId,
    cancelledAt: null,
    registeredAt: status === "registered" ? now : null,
    waitlistedAt: status === "waitlisted" ? now : null,
    updatedAt: now,
  };
  // Only touch registration_source when a source is explicitly passed — preserve prior origin otherwise.
  if (opts?.source !== undefined) patch.registrationSource = opts.source;
  const [reg] = await tx
    .update(registrations)
    .set(patch)
    .where(eq(registrations.id, id))
    .returning();
  if (!reg) throw new Error("registration update returned no row");
  return reg;
}
