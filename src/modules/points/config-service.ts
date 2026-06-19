import { eq, sql } from "drizzle-orm";
import { db, type Tx } from "../../db/client";
import {
  eventPointConfig,
  pointSettings,
  type EventPointConfigRow,
  type PointSettingsRow,
} from "../../db/schema/point-config";
import type { Event } from "../../db/schema/events";

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

// Toggles default when no config row exists: in=enabled, out=disabled (matches schema defaults).
export function isCheckinInEnabled(config: EventPointConfigRow | null): boolean {
  return config?.checkinInEnabled ?? true;
}

export function isCheckinOutEnabled(config: EventPointConfigRow | null): boolean {
  return config?.checkinOutEnabled ?? false;
}

// Assessment toggle default when no config row exists: disabled (matches schema default).
export function isAssessmentEnabled(config: EventPointConfigRow | null): boolean {
  return config?.assessmentEnabled ?? false;
}

// Anti-farm gate (H3) default: assessment requires the student be checked in for the event.
export function assessmentRequiresCheckin(config: EventPointConfigRow | null): boolean {
  return config?.assessmentRequiresCheckin ?? true;
}

// Assessment window (§4.3): override [assessmentOpenAt..assessmentCloseAt], else open from event.eventStartAt,
// never closing (until the global cutoff). null open = not yet open if eventStartAt is also null? — see handler.
export function assessmentWindow(
  config: EventPointConfigRow | null,
  event: Pick<Event, "eventStartAt">,
): { open: Date | null; close: Date | null } {
  if (config?.assessmentOpenAt != null || config?.assessmentCloseAt != null) {
    return { open: config.assessmentOpenAt ?? null, close: config.assessmentCloseAt ?? null };
  }
  // Default: opens at eventStartAt (null = unbounded open), never auto-closes.
  return { open: event.eventStartAt, close: null };
}

// Cutoff freeze (§5/§10): once cutoffAt has passed, all STUDENT earning is rejected.
export function isPastCutoff(settings: PointSettingsRow, now: Date): boolean {
  return settings.cutoffAt != null && now > settings.cutoffAt;
}

// Scan-IN window (§4.1): config override [scanInOpenAt..scanInCloseAt], else event check-in window.
export function scanInWindow(
  config: EventPointConfigRow | null,
  event: Pick<Event, "checkinOpenAt" | "checkinCloseAt">,
): { open: Date | null; close: Date | null } {
  if (config?.scanInOpenAt != null || config?.scanInCloseAt != null) {
    return { open: config.scanInOpenAt ?? null, close: config.scanInCloseAt ?? null };
  }
  return { open: event.checkinOpenAt, close: event.checkinCloseAt };
}

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
  if (event.eventEndAt == null) return { open: null, close: null };
  const close = new Date(event.eventEndAt.getTime() + settings.scanOutFallbackHours * 60 * 60 * 1000);
  return { open: event.eventEndAt, close };
}
