import { Hono } from "hono";
import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { events, type Event } from "../../db/schema/events";
import { registrations } from "../../db/schema/registrations";
import { auditLogs } from "../../db/schema/audit";
import { registrationQrTokens } from "../../db/schema/qr";
import { users } from "../../db/schema/users";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { canManualCheckin, canScanCheckin, canManageCheckinState } from "../../lib/permissions";
import { badRequest, notFound } from "../../lib/errors";
import { writeAudit } from "../../lib/audit";
import { checkinsTotal } from "../../lib/metrics";
import { hashToken } from "../../lib/crypto";
import { isWithinWindow, effectiveCheckinClose } from "../../lib/time";
import { awardCheckinIn, awardCheckinOut, reverseCheckinOnUndo, reverseCheckoutOnUndo } from "../points/checkin-award";
import { getEventPointConfig, getPointSettings, isCheckinOutEnabled, isPastCutoff, scanOutWindow, isScanOutOpen } from "../points/config-service";

const router = new Hono<{ Variables: AppVariables }>();

// ---- Zod boundary schemas ----
const eventIdParam = z.object({ eventId: z.string().uuid() });
const regIdParam = z.object({ registrationId: z.string().uuid() });
// scan_type defaults to "in" so existing IN callers are unaffected; "out" runs the scan-out flow (§4.2).
// dry_run = resolve-only preview: runs the full validation ladder but commits NOTHING, returning identity
// + "ready" so the scanner can show a confirm dialog before the real (dry_run:false) commit scan.
const scanBody = z.object({
  qr_token: z.string().min(1),
  scan_type: z.enum(["in", "out"]).default("in"),
  dry_run: z.boolean().default(false),
});
const searchQuery = z.object({ q: z.string().min(1) });
const reasonBody = z.object({ reason: z.string().min(1) });

// Scan outcome codes — returned in body (HTTP 200) so the UI can branch. Never an exception.
type ScanResult =
  | "ready" // dry-run preview only: all checks pass, awaiting staff confirm (never a committed state)
  | "checked_in_success"
  | "already_checked_in"
  | "checked_out_success"
  | "already_checked_out"
  | "not_checked_in" // scan-out attempted before a check-in exists
  | "scan_window_closed" // points §4.1 — outside the scan-in/out window
  | "points_closed" // points §5/§10 — past the leaderboard cutoff
  | "checkout_disabled" // event's checkinOutEnabled toggle is off
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

// Per-event check-OUT availability for the staff UI badges. "disabled" = toggle off OR no resolvable
// window (no eventEndAt + no override → scan-out never opens) → UI treats it as "no check-out".
type CheckoutState = "disabled" | "before" | "open" | "closed";
function checkoutStateOf(
  config: Awaited<ReturnType<typeof getEventPointConfig>>,
  event: Pick<Event, "eventEndAt">,
  settings: Awaited<ReturnType<typeof getPointSettings>>,
  now: Date,
): CheckoutState {
  if (!isCheckinOutEnabled(config)) return "disabled";
  const win = scanOutWindow(config, event, settings);
  if (win.open == null) return "disabled"; // unresolved anchor → never opens → effectively no check-out
  if (now < win.open) return "before";
  if (win.close && now > win.close) return "closed";
  return "open";
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

  // Per-event check-out state so the list can show a check-out badge alongside check-in (and adapt
  // when an event has no check-out configured). Small capable list → per-event config read is fine.
  const settings = await getPointSettings();
  const now = new Date();
  const checkoutByEvent = new Map<string, CheckoutState>();
  // Resolved scan-out window per event so the card can show the check-out time range (not just check-in).
  const outWinByEvent = new Map<string, { open: string | null; close: string | null }>();
  for (const e of capable) {
    const config = await getEventPointConfig(e.id);
    checkoutByEvent.set(e.id, checkoutStateOf(config, e, settings, now));
    const w = scanOutWindow(config, e, settings);
    outWinByEvent.set(e.id, { open: w.open?.toISOString() ?? null, close: w.close?.toISOString() ?? null });
  }

  return c.json({
    events: capable.map((e) => {
      const ct = countByEvent.get(e.id);
      return {
        id: e.id,
        title: e.title,
        location: e.location,
        checkinOpenAt: e.checkinOpenAt?.toISOString() ?? null,
        checkinCloseAt: e.checkinCloseAt?.toISOString() ?? null,
        // Open-now uses effective close (blank close = event end) so it matches the scan gate.
        checkinOpen: isWithinWindow(now, e.checkinOpenAt, effectiveCheckinClose(e.checkinCloseAt, e.eventEndAt)),
        // Check-out availability/state for the UI badge ("disabled" = no check-out for this event).
        checkoutState: checkoutByEvent.get(e.id) ?? "disabled",
        // Resolved scan-out window (null when no check-out) so the card can show the check-out range.
        scanOutOpenAt: outWinByEvent.get(e.id)?.open ?? null,
        scanOutCloseAt: outWinByEvent.get(e.id)?.close ?? null,
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
        // Checked-out = checked-in regs that also have a scan-out stamp (the check-out screen's metric).
        checkedOut: sql<number>`count(*) filter (where ${registrations.checkedOutAt} is not null)::int`,
      })
      .from(registrations)
      .where(eq(registrations.eventId, eventId));

    // Check-out window/state so the check-out scanner header shows a real badge + window (not the
    // check-in window). scanOutWindow resolves override-else-fallback bounds; checkoutStateOf adds the toggle.
    const settings = await getPointSettings();
    const config = await getEventPointConfig(eventId);
    const now = new Date();
    const outWin = scanOutWindow(config, event, settings);

    return c.json({
      event: {
        id: event.id,
        title: event.title,
        status: event.status,
        checkinOpenAt: event.checkinOpenAt?.toISOString() ?? null,
        checkinCloseAt: event.checkinCloseAt?.toISOString() ?? null,
        // Open-now uses effective close (blank close = event end) so it matches the scan gate.
        checkinOpen: isWithinWindow(now, event.checkinOpenAt, effectiveCheckinClose(event.checkinCloseAt, event.eventEndAt)),
        // Check-out side — drives the OUT scanner header badge + window line.
        checkoutState: checkoutStateOf(config, event, settings, now),
        scanOutOpenAt: outWin.open?.toISOString() ?? null,
        scanOutCloseAt: outWin.close?.toISOString() ?? null,
      },
      counts: {
        registered: counts?.registered ?? 0,
        checkedIn: counts?.checkedIn ?? 0,
        checkedOut: counts?.checkedOut ?? 0,
      },
    });
  },
);

// My check-in/out action history for one event — what the CURRENT staff did here (persistent, survives
// reload, unlike the in-memory recent-scans strip). Backs the "ประวัติ" tab so staff can find + undo
// their own mistakes. Scoped to actorUserId = me; both directions (in + out) + their undos, newest first.
const MY_HISTORY_ACTIONS = [
  "qr_scan_checkin",
  "qr_scan_checkout",
  "manual_checkin",
  "manual_checkout",
  "manual_checkin_undo",
  "manual_checkout_undo",
] as const;
const MY_HISTORY_LIMIT = 50;

router.get(
  "/staff/events/:eventId/my-history",
  requireAuth,
  requirePermission(canScanCheckin),
  async (c) => {
    const { eventId } = eventIdParam.parse(c.req.param());
    const staff = c.get("user");
    const target = alias(users, "target_user");

    const rows = await db
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        createdAt: auditLogs.createdAt,
        registrationId: auditLogs.registrationId,
        // Current reg stamps drive whether the action is still reversible (avoid offering undo on stale rows).
        regStatus: registrations.status,
        regCheckedInAt: registrations.checkedInAt,
        regCheckedOutAt: registrations.checkedOutAt,
        fullName: target.fullName,
        studentId: target.studentId,
        pointsAwarded: sql<number | null>`(${auditLogs.newValue} ->> 'pointsAwarded')::int`,
      })
      .from(auditLogs)
      .leftJoin(registrations, eq(registrations.id, auditLogs.registrationId))
      .leftJoin(target, eq(target.id, auditLogs.targetUserId))
      .where(
        and(
          eq(auditLogs.actorUserId, staff.id),
          eq(auditLogs.eventId, eventId),
          inArray(auditLogs.action, [...MY_HISTORY_ACTIONS]),
        ),
      )
      .orderBy(desc(auditLogs.createdAt))
      .limit(MY_HISTORY_LIMIT);

    return c.json({
      items: rows.map((r) => ({
        id: r.id,
        action: r.action,
        at: r.createdAt.toISOString(),
        registrationId: r.registrationId,
        fullName: r.fullName,
        studentId: r.studentId,
        pointsAwarded: r.pointsAwarded ?? null,
        // Reversible now? IN action → still checked_in; OUT action → still has a checkout stamp. Undo rows: never.
        canUndoCheckin: r.action === "qr_scan_checkin" || r.action === "manual_checkin"
          ? r.regStatus === "checked_in"
          : false,
        canUndoCheckout: r.action === "qr_scan_checkout" || r.action === "manual_checkout"
          ? r.regCheckedOutAt != null
          : false,
      })),
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
    const scanType = body.scan_type;
    const dryRun = body.dry_run;
    const staff = c.get("user");
    const meta = requestMeta(c);
    const log = c.get("log");
    log.set("action", "checkin.scan").set("eventId", eventId).set("scanType", scanType); // WHAT — 5WH action marker
    const tokenHash = hashToken(body.qr_token);

    // Identity travels with every reg-bearing outcome so staff can confirm WHO the scan was for
    // (fast one-by-one gate). Scanner-minimal: name + student_id only — no email/phone/answers.
    type ScanOut = {
      result: ScanResult;
      registrationId?: string;
      fullName?: string | null;
      studentId?: string | null;
      status?: string; // current reg status — surfaced on the "ready" preview so the confirm dialog shows it
      checkedInAt?: string | null;
      checkedOutAt?: string | null;
      originalCheckedInAt?: string | null;
      checkedInBy?: string | null;
      pointsAwarded?: number; // §4.2 — surfaces "+N" to the UI (0 when no/duplicate award)
    };

    const result = await db.transaction(async (tx): Promise<ScanOut> => {
      // Look up token by hash. Lock the token row (.for("update")) so a concurrent revoke/regenerate
      // (which UPDATEs qr_tokens) serializes against this scan — closes the TOCTOU where a revoke
      // committed mid-scan was ignored and the scan still checked in + awarded points.
      // Lock order is always token → registration (revoke only touches qr_tokens), so no deadlock.
      const [token] = await tx
        .select()
        .from(registrationQrTokens)
        .where(eq(registrationQrTokens.tokenHash, tokenHash))
        .for("update")
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

      // Resolve identity once; attach to every outcome below via spread. role drives the points guard.
      const [u] = await tx
        .select({ fullName: users.fullName, studentId: users.studentId, role: users.role })
        .from(users)
        .where(eq(users.id, reg.userId))
        .limit(1);
      const who = { registrationId: reg.id, fullName: u?.fullName ?? null, studentId: u?.studentId ?? null };
      const studentRole = u?.role ?? "student";

      // Token must belong to a registration of THIS event.
      // Do NOT leak identity (fullName/studentId) cross-event — only return WHO once the event matches.
      if (reg.eventId !== eventId) return { result: "wrong_event", registrationId: reg.id };

      const [event] = await tx.select().from(events).where(eq(events.id, reg.eventId)).limit(1);
      if (!event) return { result: "event_not_published", ...who };
      if (event.status === "cancelled") return { result: "event_cancelled", ...who };
      if (event.status !== "published") return { result: "event_not_published", ...who };

      const now = new Date();

      // Common rejects for both directions.
      if (reg.status === "cancelled") return { result: "registration_cancelled", ...who };
      if (reg.status === "waitlisted") return { result: "waitlisted_not_allowed", ...who };

      // ----- SCAN OUT (§4.2): requires an existing check-in, scan-out window, and the toggle. -----
      if (scanType === "out") {
        if (reg.status !== "checked_in") return { result: "not_checked_in", ...who };
        if (reg.checkedOutAt)
          return { result: "already_checked_out", ...who, checkedOutAt: reg.checkedOutAt.toISOString() };

        const settings = await getPointSettings(tx);
        const config = await getEventPointConfig(reg.eventId, tx);
        if (!isCheckinOutEnabled(config)) return { result: "checkout_disabled", ...who };
        // Cutoff freeze blocks the OUT scan entirely (it only exists to award points).
        if (isPastCutoff(settings, now)) return { result: "points_closed", ...who };
        const win = scanOutWindow(config, event, settings);
        if (!isScanOutOpen(win, now)) return { result: "scan_window_closed", ...who };

        // All OUT checks pass — preview stops here (no mutation), real scan continues to commit.
        if (dryRun) return { result: "ready", ...who, status: reg.status };

        await tx
          .update(registrations)
          .set({ checkedOutAt: now, checkedOutByUserId: staff.id, updatedAt: now })
          .where(eq(registrations.id, reg.id));

        const award = await awardCheckinOut(tx, {
          eventId: reg.eventId,
          registrationId: reg.id,
          studentUserId: reg.userId,
          studentRole,
          scannedByUserId: staff.id,
          eventTitle: event.title,
        });

        await writeAudit(
          {
            actorUserId: staff.id,
            actorRole: staff.role,
            action: "qr_scan_checkout",
            entityType: "registration",
            entityId: reg.id,
            eventId: reg.eventId,
            registrationId: reg.id,
            targetUserId: reg.userId,
            newValue: { checkedOut: true, pointsAwarded: award.pointsAwarded },
            ...meta,
          },
          tx,
        );
        return { result: "checked_out_success", ...who, checkedOutAt: now.toISOString(), pointsAwarded: award.pointsAwarded };
      }

      // ----- SCAN IN (default): check-in window, then check-in + points award. -----
      // Effective close = explicit close, else event end (scan-in must not outlast the event).
      const checkinClose = effectiveCheckinClose(event.checkinCloseAt, event.eventEndAt);
      if (event.checkinOpenAt && now < event.checkinOpenAt)
        return { result: "checkin_not_open", ...who };
      if (checkinClose && now > checkinClose)
        return { result: "checkin_closed", ...who };

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

      // All IN checks pass — preview stops here (no mutation), real scan continues to commit.
      if (dryRun) return { result: "ready", ...who, status: reg.status };

      // Success: registered → checked_in via QR scan.
      await tx
        .update(registrations)
        .set({
          status: "checked_in",
          checkedInAt: now,
          checkedInByUserId: staff.id,
          checkinMethod: "qr_scan",
          // Clear any stale undo reason so a fresh check-in starts clean (don't leak old reason to CSV export).
          manualCheckinReason: null,
          updatedAt: now,
        })
        .where(eq(registrations.id, reg.id));

      // Award checkin_in points in the SAME tx (student + toggle + cutoff guarded inside; idempotent).
      const award = await awardCheckinIn(tx, {
        eventId: reg.eventId,
        registrationId: reg.id,
        studentUserId: reg.userId,
        studentRole,
        scannedByUserId: staff.id,
        eventTitle: event.title,
      });

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
          newValue: { status: "checked_in", method: "qr_scan", pointsAwarded: award.pointsAwarded },
          ...meta,
        },
        tx,
      );
      return { result: "checked_in_success", ...who, checkedInAt: now.toISOString(), pointsAwarded: award.pointsAwarded };
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
        checkedOutAt: registrations.checkedOutAt,
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
        checkedOutAt: r.checkedOutAt?.toISOString() ?? null,
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
    let pointsAwarded = 0; // surfaced in the response so the UI can show "+N" like the QR path
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

      // Registrant's role decides point eligibility (only students earn) — same as the QR scan path.
      const [u] = await tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, reg.userId))
        .limit(1);
      const studentRole = u?.role ?? "student";
      // Effective close = explicit close, else event end (scan-in must not outlast the event).
      if (!isWithinWindow(now, event.checkinOpenAt, effectiveCheckinClose(event.checkinCloseAt, event.eventEndAt)))
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
          // Clear any stale undo reason so a fresh check-in starts clean (don't leak old reason to CSV export).
          manualCheckinReason: null,
          updatedAt: now,
        })
        .where(eq(registrations.id, reg.id));

      // Award checkin_in points in the SAME tx — mirrors the QR scan path so attendance is rewarded
      // regardless of check-in method. Student + toggle + cutoff guarded inside; idempotent via dedupeKey.
      const award = await awardCheckinIn(tx, {
        eventId: reg.eventId,
        registrationId: reg.id,
        studentUserId: reg.userId,
        studentRole,
        scannedByUserId: staff.id,
        eventTitle: event.title,
        scanMethod: "manual_search",
      });
      pointsAwarded = award.pointsAwarded;

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
          newValue: { status: "checked_in", method: "manual_search", pointsAwarded: award.pointsAwarded },
          ...meta,
        },
        tx,
      );
    });

    // Tx committed → this is a real manual check-in; count it by event.
    if (checkedInEventId) checkinsTotal.inc({ event: checkedInEventId });
    log.set("outcome", "checked_in_success");
    return c.json({ result: "checked_in_success", checkedInAt: now.toISOString(), pointsAwarded });
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
          // Undo also clears any scan-out stamp (the check-in it depended on is gone).
          checkedOutAt: null,
          checkedOutByUserId: null,
          manualCheckinReason: reason,
          updatedAt: new Date(),
        })
        .where(eq(registrations.id, reg.id));

      // U6: undo must reverse BOTH awarded checkin_in and checkin_out points (negative correction_reverse,
      // idempotent, does not move lastPositiveAt). No-op per leg when that leg was never awarded.
      const rev = await reverseCheckinOnUndo(tx, {
        registrationId: reg.id,
        studentUserId: reg.userId,
        undoneByUserId: staff.id,
        reason,
      });

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
          newValue: { status: "registered", pointsReversed: rev.reversed },
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
// MANUAL CHECK-OUT + UNDO  (§4.2 — mirrors manual check-in for the staff checkout surface)
// =====================================================================

// Manual check-out by registration id (after search). Same guard ladder as the QR scan-OUT path,
// surfaced as thrown error codes (the manual UI toasts ApiError.message). scan_method = manual_search.
router.post(
  "/registrations/:registrationId/manual-checkout",
  requireAuth,
  requirePermission(canManualCheckin),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const staff = c.get("user");
    const meta = requestMeta(c);
    const log = c.get("log");
    log.set("action", "checkout.manual"); // WHAT — 5WH action marker
    const now = new Date();

    let pointsAwarded = 0; // surfaced so the UI can show "+N" like the QR path
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

      // Registrant's role decides point eligibility (only students earn) — same as the QR path.
      const [u] = await tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, reg.userId))
        .limit(1);
      const studentRole = u?.role ?? "student";

      // OUT requires an existing check-in, the toggle, an open window, and pre-cutoff (same as scan-OUT).
      if (reg.status !== "checked_in") throw badRequest("not_checked_in", "Registration is not checked in");
      if (reg.checkedOutAt) throw badRequest("already_checked_out", "Already checked out");
      const settings = await getPointSettings(tx);
      const config = await getEventPointConfig(reg.eventId, tx);
      if (!isCheckinOutEnabled(config)) throw badRequest("checkout_disabled", "Check-out is not enabled for this event");
      if (isPastCutoff(settings, now)) throw badRequest("points_closed", "Points are closed");
      const win = scanOutWindow(config, event, settings);
      if (!isScanOutOpen(win, now)) throw badRequest("scan_window_closed", "Check-out window is not open");

      await tx
        .update(registrations)
        .set({ checkedOutAt: now, checkedOutByUserId: staff.id, updatedAt: now })
        .where(eq(registrations.id, reg.id));

      const award = await awardCheckinOut(tx, {
        eventId: reg.eventId,
        registrationId: reg.id,
        studentUserId: reg.userId,
        studentRole,
        scannedByUserId: staff.id,
        eventTitle: event.title,
        scanMethod: "manual_search",
      });
      pointsAwarded = award.pointsAwarded;

      await writeAudit(
        {
          actorUserId: staff.id,
          actorRole: staff.role,
          action: "manual_checkout",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          newValue: { checkedOut: true, method: "manual_search", pointsAwarded: award.pointsAwarded },
          ...meta,
        },
        tx,
      );
    });

    log.set("outcome", "checked_out_success");
    return c.json({ result: "checked_out_success", checkedOutAt: now.toISOString(), pointsAwarded });
  },
);

// Undo check-out (reason required). Clears ONLY the scan-out stamp + its points — the check-in stays.
router.post(
  "/registrations/:registrationId/undo-checkout",
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
      if (!reg.checkedOutAt) throw badRequest("not_checked_out", "Registration is not checked out");

      await tx
        .update(registrations)
        .set({ checkedOutAt: null, checkedOutByUserId: null, updatedAt: new Date() })
        .where(eq(registrations.id, reg.id));

      // Reverse ONLY the checkin_out leg — the check-in (and its points) remain untouched.
      const rev = await reverseCheckoutOnUndo(tx, {
        registrationId: reg.id,
        studentUserId: reg.userId,
        undoneByUserId: staff.id,
        reason,
      });

      await writeAudit(
        {
          actorUserId: staff.id,
          actorRole: staff.role,
          action: "manual_checkout_undo",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: { checkedOut: true },
          newValue: { checkedOut: false, pointsReversed: rev.reversed },
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
// ADMIN CHECK-IN / CHECK-OUT STATE OVERRIDE  (admin-grade, bypasses window/toggle/cutoff gates)
// =====================================================================

// Per-axis discriminated action. "set" may backdate via `at` (ISO-UTC; frontend converts the naive
// Bangkok datetime-local → UTC before POST) + opt out of points via awardPoints. Default = "unchanged".
const axisSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("set"),
      at: z.string().datetime().optional(), // ISO-8601 UTC; omitted → now()
      awardPoints: z.boolean().default(true),
    }),
    z.object({ action: z.literal("clear") }),
    z.object({ action: z.literal("unchanged") }),
  ])
  .default({ action: "unchanged" });

const checkinStateBody = z.object({
  checkin: axisSchema,
  checkout: axisSchema,
  reason: z.string().min(1),
});

// Warning code surfaced when a stamp committed but points were NOT awarded (cutoff/toggle/role guard).
type PointsSkipped = string;

// POST /admin/registrations/:registrationId/checkin-state — admin direct set/clear/backdate of
// check-in/check-out stamps. Bypasses window/toggle/cutoff for the STAMP (admin authority), but the
// points award fns self-guard → when skipped we return a `points_skipped` warning (never silent).
router.post(
  "/admin/registrations/:registrationId/checkin-state",
  requireAuth,
  requirePermission(canManageCheckinState),
  async (c) => {
    const { registrationId } = regIdParam.parse(c.req.param());
    const body = checkinStateBody.parse(await c.req.json());
    const admin = c.get("user");
    const meta = requestMeta(c);
    const log = c.get("log");
    log.set("action", "checkin.state_override"); // WHAT — 5WH action marker

    // Both axes untouched → nothing to do (no empty audit row). [E14]
    if (body.checkin.action === "unchanged" && body.checkout.action === "unchanged")
      throw badRequest("no_changes", "No check-in/out changes requested");

    const now = new Date();

    type StateResult = {
      checkedInAt: string | null;
      checkedOutAt: string | null;
      pointsSkipped: PointsSkipped[]; // award guards that fired so the UI can warn the admin
    };

    const result = await db.transaction(async (tx): Promise<StateResult> => {
      // Lock the reg row ONLY (lock order reg-only vs scan's token→reg → no deadlock). [E10]
      const [reg] = await tx
        .select()
        .from(registrations)
        .where(eq(registrations.id, registrationId))
        .for("update")
        .limit(1);
      if (!reg) throw notFound("Registration not found");

      const [event] = await tx.select().from(events).where(eq(events.id, reg.eventId)).limit(1);
      if (!event) throw notFound("Event not found");

      // Registrant role decides point eligibility (only students earn) — same as the scan/manual paths.
      const [u] = await tx
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, reg.userId))
        .limit(1);
      const studentRole = u?.role ?? "student";

      // Provenance captured BEFORE any mutation so the audit preserves the old stamps + method
      // (e.g. overwriting a qr_scan check-in). [E13]
      const oldCheckedInAt = reg.checkedInAt;
      const oldCheckedOutAt = reg.checkedOutAt;
      const oldCheckinMethod = reg.checkinMethod;
      const oldStatus = reg.status;

      // ---- Resolve & validate the requested `at` values up front (reject future). [E8] ----
      let inAt: Date | null = null;
      if (body.checkin.action === "set") {
        inAt = body.checkin.at ? new Date(body.checkin.at) : now;
        if (inAt > now) throw badRequest("at_in_future", "Check-in time cannot be in the future");
      }
      let outAt: Date | null = null;
      if (body.checkout.action === "set") {
        outAt = body.checkout.at ? new Date(body.checkout.at) : now;
        if (outAt > now) throw badRequest("at_in_future", "Check-out time cannot be in the future");
      }

      // ---- Compute POST-OP effective state (what the stamps WILL be after this request). ----
      // checkin axis
      let effCheckedInAt: Date | null = oldCheckedInAt;
      if (body.checkin.action === "set") effCheckedInAt = inAt;
      else if (body.checkin.action === "clear") effCheckedInAt = null;
      // checkout axis (clear-checkin cascades a checkout clear)
      let effCheckedOutAt: Date | null = oldCheckedOutAt;
      if (body.checkin.action === "clear") effCheckedOutAt = null; // [E3] cascade — can't be out without in
      if (body.checkout.action === "set") effCheckedOutAt = outAt;
      else if (body.checkout.action === "clear") effCheckedOutAt = null;

      // ---- Invariants (§3) validated against POST-OP state. ----
      // Set-checkin only valid from registered/checked_in — never resurrect cancelled/waitlisted. [E5]
      if (body.checkin.action === "set" && oldStatus !== "registered" && oldStatus !== "checked_in")
        throw badRequest("checkin_blocked_status", "Cannot set check-in on a cancelled/waitlisted registration");
      // Checkout requires a check-in to exist after this request. [E6]
      if (effCheckedOutAt && !effCheckedInAt)
        throw badRequest("checkout_without_checkin", "Cannot check out without a check-in");
      // checkedOutAt >= checkedInAt against post-op effective values. [E6]
      if (effCheckedOutAt && effCheckedInAt && effCheckedOutAt < effCheckedInAt)
        throw badRequest("checkout_before_checkin", "Check-out time cannot be before check-in time");

      const pointsSkipped: PointsSkipped[] = [];

      // ---- CLEAR CHECK-IN (cascades checkout clear; reverses BOTH legs via ONE call). [E3] ----
      if (body.checkin.action === "clear") {
        await tx
          .update(registrations)
          .set({
            status: "registered",
            checkedInAt: null,
            checkedInByUserId: null,
            checkinMethod: null, // [E12] no stale provenance
            manualCheckinReason: body.reason, // record WHY this clear happened
            checkedOutAt: null, // cascade — checkout depends on check-in
            checkedOutByUserId: null,
            updatedAt: now,
          })
          .where(eq(registrations.id, reg.id));
        // ONE reverse call handles both checkin_in + checkin_out legs — never also call
        // reverseCheckoutOnUndo here (would double-reverse the OUT leg). [E3]
        await reverseCheckinOnUndo(tx, {
          registrationId: reg.id,
          studentUserId: reg.userId,
          undoneByUserId: admin.id,
          reason: body.reason,
        });
      }

      // ---- SET CHECK-IN (new check-in or backdate of an existing one). ----
      if (body.checkin.action === "set") {
        await tx
          .update(registrations)
          .set({
            status: "checked_in",
            checkedInAt: inAt,
            checkedInByUserId: admin.id,
            checkinMethod: "admin_override",
            manualCheckinReason: body.reason,
            updatedAt: now,
          })
          .where(eq(registrations.id, reg.id));
        if (body.checkin.awardPoints) {
          // Stamp bypasses cutoff/toggle, but the award self-guards → surface a warning if it skips. [E1]
          const award = await awardCheckinIn(tx, {
            eventId: reg.eventId,
            registrationId: reg.id,
            studentUserId: reg.userId,
            studentRole,
            scannedByUserId: admin.id,
            eventTitle: event.title,
            scanMethod: "admin_override",
          });
          if ("skipped" in award) pointsSkipped.push(`checkin_in:${award.skipped}`);
        }
      }

      // ---- CLEAR CHECK-OUT (only when checkin wasn't cleared — that cascade already wiped it). ----
      if (body.checkout.action === "clear" && body.checkin.action !== "clear") {
        await tx
          .update(registrations)
          .set({ checkedOutAt: null, checkedOutByUserId: null, updatedAt: now })
          .where(eq(registrations.id, reg.id));
        await reverseCheckoutOnUndo(tx, {
          registrationId: reg.id,
          studentUserId: reg.userId,
          undoneByUserId: admin.id,
          reason: body.reason,
        });
      }

      // ---- SET CHECK-OUT (post-op checkin presence already validated above). ----
      if (body.checkout.action === "set") {
        await tx
          .update(registrations)
          .set({ checkedOutAt: outAt, checkedOutByUserId: admin.id, updatedAt: now })
          .where(eq(registrations.id, reg.id));
        if (body.checkout.awardPoints) {
          const award = await awardCheckinOut(tx, {
            eventId: reg.eventId,
            registrationId: reg.id,
            studentUserId: reg.userId,
            studentRole,
            scannedByUserId: admin.id,
            eventTitle: event.title,
            scanMethod: "admin_override",
          });
          if ("skipped" in award) pointsSkipped.push(`checkin_out:${award.skipped}`);
        }
      }

      await writeAudit(
        {
          actorUserId: admin.id,
          actorRole: admin.role,
          action: "admin_checkin_state_edit",
          entityType: "registration",
          entityId: reg.id,
          eventId: reg.eventId,
          registrationId: reg.id,
          targetUserId: reg.userId,
          oldValue: {
            status: oldStatus,
            checkedInAt: oldCheckedInAt?.toISOString() ?? null,
            checkedOutAt: oldCheckedOutAt?.toISOString() ?? null,
            checkinMethod: oldCheckinMethod, // provenance preserved when overwriting a qr_scan [E13]
          },
          newValue: {
            checkin: body.checkin.action,
            checkout: body.checkout.action,
            checkedInAt: effCheckedInAt?.toISOString() ?? null,
            checkedOutAt: effCheckedOutAt?.toISOString() ?? null,
            pointsSkipped,
          },
          reason: body.reason,
          ...meta,
        },
        tx,
      );

      return {
        checkedInAt: effCheckedInAt?.toISOString() ?? null,
        checkedOutAt: effCheckedOutAt?.toISOString() ?? null,
        pointsSkipped,
      };
    });

    log.set("outcome", "checkin_state_edited");
    // points_skipped: non-empty when a stamp committed but points were withheld (admin must know). [E1/E2]
    return c.json({
      ok: true,
      checkedInAt: result.checkedInAt,
      checkedOutAt: result.checkedOutAt,
      points_skipped: result.pointsSkipped,
    });
  },
);

export default router;
