import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import {
  eventPointConfig,
  pointSettings,
  type EventPointConfigRow,
  type PointSettingsRow,
} from "../../db/schema/point-config";
import type { Event } from "../../db/schema/events";
import { writeAudit } from "../../lib/audit";
import { isWithinWindow } from "../../lib/time";

type Exec = Tx | typeof db;

// Read the singleton point_settings row, lazy-creating row 1 with documented defaults if absent.
// Singleton guarantee: id is always 1; ON CONFLICT DO NOTHING keeps it a no-op under concurrency.
export async function getPointSettings(exec: Exec = db): Promise<PointSettingsRow> {
  const [existing] = await exec.select().from(pointSettings).where(eq(pointSettings.id, 1)).limit(1);
  if (existing) return existing;
  // Lazy-create the singleton; defaults come from the column .default()s in the schema.
  await exec.insert(pointSettings).values({ id: 1 }).onConflictDoNothing();
  const [row] = await exec.select().from(pointSettings).where(eq(pointSettings.id, 1)).limit(1);
  if (!row) throw new Error("getPointSettings: singleton row missing after lazy-create");
  return row;
}

// Per-event config row, or null when the event has no overrides (use all global defaults).
export async function getEventPointConfig(
  eventId: string,
  exec: Exec = db,
): Promise<EventPointConfigRow | null> {
  const [row] = await exec
    .select()
    .from(eventPointConfig)
    .where(eq(eventPointConfig.eventId, eventId))
    .limit(1);
  return row ?? null;
}

// Effective-points resolution (COALESCE): per-event override wins, else global default.
// This is THE single place the override→default rule lives — callers never inline it.
export function effectiveCheckinInPoints(
  config: EventPointConfigRow | null,
  settings: PointSettingsRow,
): number {
  return config?.checkinInPoints ?? settings.defaultCheckinInPoints;
}

export function effectiveCheckinOutPoints(
  config: EventPointConfigRow | null,
  settings: PointSettingsRow,
): number {
  return config?.checkinOutPoints ?? settings.defaultCheckinOutPoints;
}

// Assessment award (§4.3): per-event override wins, else global default (100).
export function effectiveAssessmentPoints(
  config: EventPointConfigRow | null,
  settings: PointSettingsRow,
): number {
  return config?.assessmentPoints ?? settings.defaultAssessmentPoints;
}

// Toggles default when no config row exists: in + out = enabled (matches schema defaults).
// Check-out defaults ON so an admin only needs to set the check-out window time — no toggle hunt.
export function isCheckinInEnabled(config: EventPointConfigRow | null): boolean {
  return config?.checkinInEnabled ?? true;
}

export function isCheckinOutEnabled(config: EventPointConfigRow | null): boolean {
  return config?.checkinOutEnabled ?? true;
}

// Assessment toggle default when no config row exists: disabled (matches schema default).
export function isAssessmentEnabled(config: EventPointConfigRow | null): boolean {
  return config?.assessmentEnabled ?? false;
}

// Anti-farm gate (H3) default: assessment requires the student be checked in for the event.
export function assessmentRequiresCheckin(config: EventPointConfigRow | null): boolean {
  return config?.assessmentRequiresCheckin ?? true;
}

// Assessment window (§4.3): open = override, else event.eventStartAt ("auto-open at event start"
// toggle = clear the override). close = override, else never auto-closes. Fallbacks are INDEPENDENT
// — a close override must NOT drop the eventStartAt open default. open=null (no override + no start)
// = unbounded open; see handler.
export function assessmentWindow(
  config: EventPointConfigRow | null,
  event: Pick<Event, "eventStartAt">,
): { open: Date | null; close: Date | null } {
  return {
    open: config?.assessmentOpenAt ?? event.eventStartAt,
    close: config?.assessmentCloseAt ?? null,
  };
}

// Cutoff freeze (§5/§10): once cutoffAt has passed, all STUDENT earning is rejected.
export function isPastCutoff(settings: PointSettingsRow, now: Date): boolean {
  return settings.cutoffAt != null && now > settings.cutoffAt;
}

// Scan-IN has NO separate window: the scan-IN / check-in action is gated directly by the event
// check-in window (checkinOpenAt/CloseAt in checkins/routes.ts). The old scanInWindow override fn
// was dead code + a footgun (un-clearable legacy scan_in_* would silently win) — removed. The
// scan_in_* columns/patch keys remain only so the edit form can force-clear legacy values to null.

// Scan-OUT window (§4.1): config override, else fallback [eventEndAt .. eventEndAt + scanOutFallbackHours].
// When eventEndAt is null and no override → open/close both null = unbounded (window always open).
export function scanOutWindow(
  config: EventPointConfigRow | null,
  event: Pick<Event, "eventEndAt">,
  settings: PointSettingsRow,
): { open: Date | null; close: Date | null } {
  if (config?.scanOutOpenAt != null || config?.scanOutCloseAt != null) {
    return { open: config.scanOutOpenAt ?? null, close: config.scanOutCloseAt ?? null };
  }
  if (event.eventEndAt == null) return { open: null, close: null }; // no anchor → window unresolved
  const close = new Date(event.eventEndAt.getTime() + settings.scanOutFallbackHours * 60 * 60 * 1000);
  return { open: event.eventEndAt, close };
}

// Scan-OUT gate. Unlike check-in, a null `open` means "no anchor" (event has no end + no override),
// NOT "open forever" — so an unanchored window is treated as NOT open yet. Prevents scan-out from
// going live the instant a student checks in on an event with no end time set.
export function isScanOutOpen(win: { open: Date | null; close: Date | null }, now: Date): boolean {
  if (win.open == null) return false;
  return isWithinWindow(now, win.open, win.close);
}

// === Admin mutations (plan §7, gated canManagePointConfig in the routes) ===

// Patchable global point-settings fields. Only these keys are accepted from the wire; everything
// else (id, updatedAt) is server-managed. cutoffAt accepts null = "unfreeze".
export type PointSettingsPatch = Partial<{
  cutoffAt: Date | null;
  defaultCheckinInPoints: number;
  defaultCheckinOutPoints: number;
  defaultAssessmentPoints: number;
  scanOutFallbackHours: number;
  peerEnabled: boolean;
  peerPoints: number;
  peerCooldownSec: number;
  staffReverseWindowMin: number;
  studentPointsVisible: boolean;
}>;

// Update the singleton point-settings (plan §5/§7). Lazy-creates row 1 first so a PATCH on a fresh
// DB works. cutoffAt is the reward-deciding freeze time → change is audited with the actor's reason.
export async function updatePointSettings(args: {
  patch: PointSettingsPatch;
  actorUserId: string;
  reason: string | null;
}): Promise<PointSettingsRow> {
  return db.transaction(async (tx) => {
    const before = await getPointSettings(tx); // lazy-creates the singleton if missing
    await tx
      .update(pointSettings)
      .set({ ...args.patch, updatedAt: new Date() })
      .where(eq(pointSettings.id, 1));
    const after = await getPointSettings(tx);
    // Audit the change; cutoff is sensitive (decides the leaderboard freeze) so we record old→new.
    await writeAudit(
      {
        actorUserId: args.actorUserId,
        action: "point_settings_update",
        entityType: "point_settings",
        // entityId is a uuid column; the settings row is the singleton (id=1), so leave it null
        // and record old→new in the value fields (cutoff is the sensitive, reward-deciding change).
        entityId: null,
        oldValue: { cutoffAt: before.cutoffAt },
        newValue: args.patch,
        reason: args.reason,
      },
      tx,
    );
    return after;
  });
}

// Patchable per-event point-config fields (nullable point/window overrides + toggles).
export type EventPointConfigPatch = Partial<{
  checkinInEnabled: boolean;
  checkinOutEnabled: boolean;
  assessmentEnabled: boolean;
  assessmentRequiresCheckin: boolean;
  checkinInPoints: number | null;
  checkinOutPoints: number | null;
  assessmentPoints: number | null;
  scanInOpenAt: Date | null;
  scanInCloseAt: Date | null;
  scanOutOpenAt: Date | null;
  scanOutCloseAt: Date | null;
  assessmentOpenAt: Date | null;
  assessmentCloseAt: Date | null;
}>;

// Upsert per-event config (plan §7/§15.3 lazy-create). Absent row = all global defaults; this writes
// (or merges) the override row. Forward-only — changing values mid-event does NOT rewrite past ledger.
export async function upsertEventPointConfig(args: {
  eventId: string;
  patch: EventPointConfigPatch;
  actorUserId: string;
}): Promise<EventPointConfigRow> {
  return db.transaction(async (tx) => {
    await tx
      .insert(eventPointConfig)
      .values({ eventId: args.eventId, ...args.patch })
      .onConflictDoUpdate({
        target: eventPointConfig.eventId,
        set: { ...args.patch, updatedAt: new Date() },
      });
    const [row] = await tx
      .select()
      .from(eventPointConfig)
      .where(eq(eventPointConfig.eventId, args.eventId))
      .limit(1);
    await writeAudit(
      {
        actorUserId: args.actorUserId,
        action: "event_point_config_update",
        entityType: "event_point_config",
        entityId: args.eventId,
        eventId: args.eventId,
        newValue: args.patch,
      },
      tx,
    );
    if (!row) throw new Error("upsertEventPointConfig: row missing after upsert");
    return row;
  });
}

// Wire shape for a point-settings row (UTC ISO timestamps).
export function serializePointSettings(s: PointSettingsRow) {
  return {
    cutoffAt: s.cutoffAt?.toISOString() ?? null,
    defaultCheckinInPoints: s.defaultCheckinInPoints,
    defaultCheckinOutPoints: s.defaultCheckinOutPoints,
    defaultAssessmentPoints: s.defaultAssessmentPoints,
    scanOutFallbackHours: s.scanOutFallbackHours,
    peerEnabled: s.peerEnabled,
    peerPoints: s.peerPoints,
    peerCooldownSec: s.peerCooldownSec,
    staffReverseWindowMin: s.staffReverseWindowMin,
    studentPointsVisible: s.studentPointsVisible,
    updatedAt: s.updatedAt.toISOString(),
  };
}

// Wire shape for an event point-config row (null when no override row exists → all defaults).
export function serializeEventPointConfig(c: EventPointConfigRow | null) {
  if (!c) return null;
  return {
    eventId: c.eventId,
    checkinInEnabled: c.checkinInEnabled,
    checkinOutEnabled: c.checkinOutEnabled,
    assessmentEnabled: c.assessmentEnabled,
    assessmentRequiresCheckin: c.assessmentRequiresCheckin,
    checkinInPoints: c.checkinInPoints,
    checkinOutPoints: c.checkinOutPoints,
    assessmentPoints: c.assessmentPoints,
    scanInOpenAt: c.scanInOpenAt?.toISOString() ?? null,
    scanInCloseAt: c.scanInCloseAt?.toISOString() ?? null,
    scanOutOpenAt: c.scanOutOpenAt?.toISOString() ?? null,
    scanOutCloseAt: c.scanOutCloseAt?.toISOString() ?? null,
    assessmentOpenAt: c.assessmentOpenAt?.toISOString() ?? null,
    assessmentCloseAt: c.assessmentCloseAt?.toISOString() ?? null,
    updatedAt: c.updatedAt.toISOString(),
  };
}
