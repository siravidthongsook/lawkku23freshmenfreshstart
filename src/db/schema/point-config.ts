import { boolean, integer, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";

// Per-event point overrides + toggles. One row per event (eventId = PK).
// FLEX: point-value columns are NULLABLE overrides — null = fall back to pointSettings global default (COALESCE).
// Lazy-created when admin opens the event's points page; absent row = all defaults (plan §3, §15.3).
export const eventPointConfig = pgTable("event_point_config", {
  eventId: uuid("event_id")
    .primaryKey()
    .references(() => events.id),
  // toggles — enable/disable each earn path per event
  checkinInEnabled: boolean("checkin_in_enabled").notNull().default(true),
  checkinOutEnabled: boolean("checkin_out_enabled").notNull().default(false),
  assessmentEnabled: boolean("assessment_enabled").notNull().default(false),
  assessmentRequiresCheckin: boolean("assessment_requires_checkin").notNull().default(true), // anti-farm (H3)
  // point-value overrides (null = COALESCE to pointSettings default)
  checkinInPoints: integer("checkin_in_points"),
  checkinOutPoints: integer("checkin_out_points"),
  assessmentPoints: integer("assessment_points"),
  // scan-window overrides (null = fall back to event time, see §4.1)
  scanInOpenAt: timestamp("scan_in_open_at", { withTimezone: true }),
  scanInCloseAt: timestamp("scan_in_close_at", { withTimezone: true }),
  scanOutOpenAt: timestamp("scan_out_open_at", { withTimezone: true }),
  scanOutCloseAt: timestamp("scan_out_close_at", { withTimezone: true }),
  assessmentOpenAt: timestamp("assessment_open_at", { withTimezone: true }), // null = fall back eventStartAt
  assessmentCloseAt: timestamp("assessment_close_at", { withTimezone: true }), // null = never closes (until cutoff)
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// System-wide point settings — single row (id always 1). Holds the global defaults that
// eventPointConfig nullable columns COALESCE to, plus the leaderboard cutoff-freeze time.
// Singleton enforced in app code (lazy-create row 1 on first read); never insert a 2nd row.
export const pointSettings = pgTable("point_settings", {
  id: integer("id").primaryKey().default(1),
  cutoffAt: timestamp("cutoff_at", { withTimezone: true }), // null = not frozen yet; past = student earning rejected
  // GLOBAL DEFAULTS — eventPointConfig nulls resolve here
  defaultCheckinInPoints: integer("default_checkin_in_points").notNull().default(20),
  defaultCheckinOutPoints: integer("default_checkin_out_points").notNull().default(20),
  defaultAssessmentPoints: integer("default_assessment_points").notNull().default(100),
  scanOutFallbackHours: integer("scan_out_fallback_hours").notNull().default(3), // §4.1 scan-out fallback window
  // peer (app-wide) — used in a later phase but defined here per plan §3
  peerEnabled: boolean("peer_enabled").notNull().default(true),
  peerPoints: integer("peer_points").notNull().default(5),
  peerCooldownSec: integer("peer_cooldown_sec").notNull().default(60),
  staffReverseWindowMin: integer("staff_reverse_window_min").notNull().default(15),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type EventPointConfigRow = typeof eventPointConfig.$inferSelect;
export type PointSettingsRow = typeof pointSettings.$inferSelect;
