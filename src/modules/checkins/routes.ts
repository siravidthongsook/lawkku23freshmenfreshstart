import { Hono } from "hono";
import { and, eq, ilike, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { events } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { registrationQrTokens } from "../../db/schema/qr";
import { users } from "../../db/schema/users";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canManualCheckin, canScanCheckin } from "../../lib/permissions";
import { badRequest, notFound } from "../../lib/errors";
import { writeAudit } from "../../lib/audit";
import { hashToken } from "../../lib/crypto";
import { isWithinWindow } from "../../lib/time";

const router = new Hono<{ Variables: AppVariables }>();

// ---- Zod boundary schemas ----
const eventIdParam = z.object({ eventId: z.string().uuid() });
const regIdParam = z.object({ registrationId: z.string().uuid() });
const scanBody = z.object({ qr_token: z.string().min(1) });
const searchQuery = z.object({ q: z.string().min(1) });
const reasonBody = z.object({ reason: z.string().min(1) });

// Scan outcome codes — returned in body (HTTP 200) so the UI can branch. Never an exception.
type ScanResult =
  | "checked_in_success"
  | "already_checked_in"
  | "wrong_event"
  | "registration_cancelled"
  | "waitlisted_not_allowed"
  | "checkin_not_open"
  | "checkin_closed"
  | "event_not_published"
  | "event_cancelled"
  | "qr_revoked"
  | "qr_invalid";

// An event is check-in-capable when published and has a check-in window configured.
function hasCheckinWindow(checkinOpenAt: Date | null, checkinCloseAt: Date | null): boolean {
  return checkinOpenAt != null || checkinCloseAt != null;
}

// =====================================================================
// SCANNER CONTEXT
// =====================================================================

// Check-in-capable events globally (published + has a check-in window).
router.get("/staff/events", requireAuth, requirePermission(canScanCheckin), async (c) => {
  const rows = await db
    .select()
    .from(events)
    .where(eq(events.status, "published"));
  const capable = rows.filter((e) => hasCheckinWindow(e.checkinOpenAt, e.checkinCloseAt));
  return c.json({
    events: capable.map((e) => ({
      id: e.id,
      title: e.title,
      location: e.location,
      checkinOpenAt: e.checkinOpenAt?.toISOString() ?? null,
      checkinCloseAt: e.checkinCloseAt?.toISOString() ?? null,
      checkinOpen: isWithinWindow(new Date(), e.checkinOpenAt, e.checkinCloseAt),
    })),
  });
});

// Scanner context + counts for one event.
router.get(
  "/staff/events/:eventId/checkin",
  requireAuth,
  requirePermission(canScanCheckin),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
    if (!event) throw notFound("Event not found");

    const [counts] = await db
      .select({
        registered: sql<number>`count(*) filter (where ${registrations.status} = 'registered')::int`,
        checkedIn: sql<number>`count(*) filter (where ${registrations.status} = 'checked_in')::int`,
      })
      .from(registrations)
      .where(eq(registrations.eventId, eventId));

    return c.json({
      event: {
        id: event.id,
        title: event.title,
        status: event.status,
        checkinOpenAt: event.checkinOpenAt?.toISOString() ?? null,
        checkinCloseAt: event.checkinCloseAt?.toISOString() ?? null,
        checkinOpen: isWithinWindow(new Date(), event.checkinOpenAt, event.checkinCloseAt),
      },
      counts: { registered: counts?.registered ?? 0, checkedIn: counts?.checkedIn ?? 0 },
    });
  },
);

// =====================================================================
// SCAN
// =====================================================================

// QR scan check-in. Returns a result code; NEVER marks success on any validation failure.
router.post(
  "/events/:eventId/checkins/scan",
  requireAuth,
  requirePermission(canScanCheckin),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const body = scanBody.parse(await c.req.json());
    const staff = c.get("user");
    const meta = requestMeta(c);
    const tokenHash = hashToken(body.qr_token);

    const result = await db.transaction(async (tx): Promise<{ result: ScanResult; registrationId?: string }> => {
      // Look up token by hash.
      const [token] = await tx
        .select()
        .from(registrationQrTokens)
        .where(eq(registrationQrTokens.tokenHash, tokenHash))
        .limit(1);
      if (!token) return { result: "qr_invalid" };
      if (token.status !== "active") return { result: "qr_revoked", registrationId: token.registrationId };

      // Lock the registration row so concurrent scans can't double check-in.
      const [reg] = await tx
        .select()
        .from(registrations)
        .where(eq(registrations.id, token.registrationId))
        .for("update")
        .limit(1);
      if (!reg) return { result: "qr_invalid" };

      // Token must belong to a registration of THIS event.
      if (reg.eventId !== eventId) return { result: "wrong_event", registrationId: reg.id };

      const [event] = await tx.select().from(events).where(eq(events.id, reg.eventId)).limit(1);
      if (!event) return { result: "event_not_published", registrationId: reg.id };
      if (event.status === "cancelled") return { result: "event_cancelled", registrationId: reg.id };
      if (event.status !== "published")
        return { result: "event_not_published", registrationId: reg.id };

      // Window: distinguish not-yet-open vs closed.
      const now = new Date();
      if (event.checkinOpenAt && now < event.checkinOpenAt)
        return { result: "checkin_not_open", registrationId: reg.id };
      if (event.checkinCloseAt && now > event.checkinCloseAt)
        return { result: "checkin_closed", registrationId: reg.id };

      // Registration status checks.
      if (reg.status === "cancelled") return { result: "registration_cancelled", registrationId: reg.id };
      if (reg.status === "waitlisted") return { result: "waitlisted_not_allowed", registrationId: reg.id };
      if (reg.status === "checked_in") return { result: "already_checked_in", registrationId: reg.id };

      // Success: registered → checked_in via QR scan.
      await tx
        .update(registrations)
        .set({
          status: "checked_in",
          checkedInAt: now,
          checkedInByUserId: staff.id,
          checkinMethod: "qr_scan",
          updatedAt: now,
        })
        .where(eq(registrations.id, reg.id));

      await writeAudit(
        {
          actorUserId: staff.id,
          actorRole: staff.role,
          action: "qr_scan_checkin",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { status: "registered" },
          newValue: { status: "checked_in", method: "qr_scan" },
          ...meta,
        },
        tx,
      );
      return { result: "checked_in_success", registrationId: reg.id };
    });

    return c.json(result);
  },
);

// =====================================================================
// MANUAL SEARCH + CHECK-IN
// =====================================================================

// Within-event search by student_id / full_name / faculty / department. Minimal info only.
router.get(
  "/events/:eventId/checkins/search",
  requireAuth,
  requirePermission(canScanCheckin),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const { q } = searchQuery.parse(c.req.query());
    const like = `%${q}%`;

    const rows = await db
      .select({
        registrationId: registrations.id,
        status: registrations.status,
        checkedInAt: registrations.checkedInAt,
        userId: users.id,
        studentId: users.studentId,
        fullName: users.fullName,
        faculty: users.faculty,
        department: users.department,
      })
      .from(registrations)
      .innerJoin(users, eq(users.id, registrations.userId))
      .where(
        and(
          eq(registrations.eventId, eventId),
          or(
            ilike(users.studentId, like),
            ilike(users.fullName, like),
            ilike(users.faculty, like),
            ilike(users.department, like),
          ),
        ),
      )
      .limit(50);

    // NO email/phone/answers/files — scanner-minimal projection only.
    return c.json({
      results: rows.map((r) => ({
        registrationId: r.registrationId,
        status: r.status,
        checkedInAt: r.checkedInAt?.toISOString() ?? null,
        studentId: r.studentId,
        fullName: r.fullName,
        faculty: r.faculty,
        department: r.department,
      })),
    });
  },
);

// Manual check-in by registration id (after search). checkin_method = manual_search.
router.post(
  "/registrations/:registrationId/manual-checkin",
  requireAuth,
  requirePermission(canManualCheckin),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const staff = c.get("user");
    const meta = requestMeta(c);

    await db.transaction(async (tx) => {
      const [reg] = await tx
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId))
        .for("update")
        .limit(1);
      if (!reg) throw notFound("Registration not found");

      const [event] = await tx.select().from(events).where(eq(events.id, reg.eventId)).limit(1);
      if (!event) throw notFound("Event not found");
      if (event.status !== "published")
        throw badRequest("event_not_published", "Event is not published");
      if (!isWithinWindow(new Date(), event.checkinOpenAt, event.checkinCloseAt))
        throw badRequest("checkin_not_open", "Check-in window is not open");

      if (reg.status === "cancelled")
        throw badRequest("registration_cancelled", "Registration is cancelled");
      if (reg.status === "waitlisted")
        throw badRequest("waitlisted_not_allowed", "Waitlisted registration cannot check in");
      if (reg.status === "checked_in")
        throw badRequest("already_checked_in", "Already checked in");

      const now = new Date();
      await tx
        .update(registrations)
        .set({
          status: "checked_in",
          checkedInAt: now,
          checkedInByUserId: staff.id,
          checkinMethod: "manual_search",
          updatedAt: now,
        })
        .where(eq(registrations.id, reg.id));

      await writeAudit(
        {
          actorUserId: staff.id,
          actorRole: staff.role,
          action: "manual_checkin",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { status: "registered" },
          newValue: { status: "checked_in", method: "manual_search" },
          ...meta,
        },
        tx,
      );
    });

    return c.json({ result: "checked_in_success" });
  },
);

// Undo check-in (reason required). checked_in → registered.
router.post(
  "/registrations/:registrationId/undo-checkin",
  requireAuth,
  requirePermission(canManualCheckin),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const { reason } = reasonBody.parse(await c.req.json());
    const staff = c.get("user");
    const meta = requestMeta(c);

    await db.transaction(async (tx) => {
      const [reg] = await tx
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId))
        .for("update")
        .limit(1);
      if (!reg) throw notFound("Registration not found");
      if (reg.status !== "checked_in")
        throw badRequest("not_checked_in", "Registration is not checked in");

      await tx
        .update(registrations)
        .set({
          status: "registered",
          checkedInAt: null,
          checkedInByUserId: null,
          checkinMethod: null,
          manualCheckinReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(registrations.id, reg.id));

      await writeAudit(
        {
          actorUserId: staff.id,
          actorRole: staff.role,
          action: "manual_checkin_undo",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { status: "checked_in" },
          newValue: { status: "registered" },
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
