import { Hono } from "hono";
import { and, eq, ilike, inArray, or, sql } from "drizzle-orm";
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
import { checkinsTotal } from "../../lib/metrics";
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

  // Per-event registered/checked-in counts so the staff list can show progress (and distinguish 0 vs unknown).
  const countRows = capable.length
    ? await db
        .select({
          eventId: registrations.eventId,
          registered: sql<number>`count(*) filter (where ${registrations.status} = 'registered')::int`,
          checkedIn: sql<number>`count(*) filter (where ${registrations.status} = 'checked_in')::int`,
        })
        .from(registrations)
        .where(
          inArray(
            registrations.eventId,
            capable.map((e) => e.id),
          ),
        )
        .groupBy(registrations.eventId)
    : [];
  const countByEvent = new Map(countRows.map((r) => [r.eventId, r]));

  return c.json({
    events: capable.map((e) => {
      const ct = countByEvent.get(e.id);
      return {
        id: e.id,
        title: e.title,
        location: e.location,
        checkinOpenAt: e.checkinOpenAt?.toISOString() ?? null,
        checkinCloseAt: e.checkinCloseAt?.toISOString() ?? null,
        checkinOpen: isWithinWindow(new Date(), e.checkinOpenAt, e.checkinCloseAt),
        // Always present (0 when no regs) so the UI can distinguish a real zero from a missing field.
        registeredCount: ct?.registered ?? 0,
        checkedInCount: ct?.checkedIn ?? 0,
      };
    }),
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
    const log = c.get("log");
    log.set("action", "checkin.scan").set("eventId", eventId); // WHAT — 5WH action marker
    const tokenHash = hashToken(body.qr_token);

    // Identity travels with every reg-bearing outcome so staff can confirm WHO the scan was for
    // (fast one-by-one gate). Scanner-minimal: name + student_id only — no email/phone/answers.
    type ScanOut = {
      result: ScanResult;
      registrationId?: string;
      fullName?: string | null;
      studentId?: string | null;
      checkedInAt?: string | null;
      originalCheckedInAt?: string | null;
      checkedInBy?: string | null;
    };

    const result = await db.transaction(async (tx): Promise<ScanOut> => {
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

      // Resolve identity once; attach to every outcome below via spread.
      const [u] = await tx
        .select({ fullName: users.fullName, studentId: users.studentId })
        .from(users)
        .where(eq(users.id, reg.userId))
        .limit(1);
      const who = { registrationId: reg.id, fullName: u?.fullName ?? null, studentId: u?.studentId ?? null };

      // Token must belong to a registration of THIS event.
      if (reg.eventId !== eventId) return { result: "wrong_event", ...who };

      const [event] = await tx.select().from(events).where(eq(events.id, reg.eventId)).limit(1);
      if (!event) return { result: "event_not_published", ...who };
      if (event.status === "cancelled") return { result: "event_cancelled", ...who };
      if (event.status !== "published") return { result: "event_not_published", ...who };

      // Window: distinguish not-yet-open vs closed.
      const now = new Date();
      if (event.checkinOpenAt && now < event.checkinOpenAt)
        return { result: "checkin_not_open", ...who };
      if (event.checkinCloseAt && now > event.checkinCloseAt)
        return { result: "checkin_closed", ...who };

      // Registration status checks.
      if (reg.status === "cancelled") return { result: "registration_cancelled", ...who };
      if (reg.status === "waitlisted") return { result: "waitlisted_not_allowed", ...who };
      if (reg.status === "checked_in") {
        // Surface original time + who did it, so staff can tell a duplicate from a fresh check-in.
        let checkedInBy: string | null = null;
        if (reg.checkedInByUserId) {
          const [s] = await tx
            .select({ fullName: users.fullName })
            .from(users)
            .where(eq(users.id, reg.checkedInByUserId))
            .limit(1);
          checkedInBy = s?.fullName ?? null;
        }
        return {
          result: "already_checked_in",
          ...who,
          originalCheckedInAt: reg.checkedInAt?.toISOString() ?? null,
          checkedInBy,
        };
      }

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
      return { result: "checked_in_success", ...who, checkedInAt: now.toISOString() };
    });

    // Count only a real check-in; all other result codes are rejects (no counter).
    if (result.result === "checked_in_success") checkinsTotal.inc({ event: eventId });
    // Every scan outcome lands in the log (success + all reject codes) — 200 either way.
    log.set("outcome", result.result);
    log.event("scan_result", { result: result.result, registrationId: result.registrationId ?? null });
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
    const log = c.get("log");
    log.set("action", "checkin.manual"); // WHAT — 5WH action marker
    // Authoritative server time — returned so the client renders this instead of its own clock.
    const now = new Date();

    // Capture the event id out of the tx so we can label the metric after commit.
    let checkedInEventId: string | null = null;
    await db.transaction(async (tx) => {
      const [reg] = await tx
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId))
        .for("update")
        .limit(1);
      if (!reg) throw notFound("Registration not found");
      checkedInEventId = reg.eventId;

      const [event] = await tx.select().from(events).where(eq(events.id, reg.eventId)).limit(1);
      if (!event) throw notFound("Event not found");
      if (event.status !== "published")
        throw badRequest("event_not_published", "Event is not published");
      if (!isWithinWindow(now, event.checkinOpenAt, event.checkinCloseAt))
        throw badRequest("checkin_not_open", "Check-in window is not open");

      if (reg.status === "cancelled")
        throw badRequest("registration_cancelled", "Registration is cancelled");
      if (reg.status === "waitlisted")
        throw badRequest("waitlisted_not_allowed", "Waitlisted registration cannot check in");
      if (reg.status === "checked_in")
        throw badRequest("already_checked_in", "Already checked in");

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

    // Tx committed → this is a real manual check-in; count it by event.
    if (checkedInEventId) checkinsTotal.inc({ event: checkedInEventId });
    log.set("outcome", "checked_in_success");
    return c.json({ result: "checked_in_success", checkedInAt: now.toISOString() });
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
