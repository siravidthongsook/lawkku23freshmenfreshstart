import { index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { checkinMethod, registrationSource, registrationStatus } from "./enums";
import { events } from "./events";
import { eventFormVersions } from "./forms";
import { users } from "./users";

// 1 record per (event,user). No hard delete — lifecycle via status.
export const registrations = pgTable(
  "registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    status: registrationStatus("status").notNull(),
    // Origin of the reg: normal (self/admin/import) vs gate walk-in (no-account student created at the gate).
    registrationSource: registrationSource("registration_source").notNull().default("normal"),
    formVersionId: uuid("form_version_id").references(() => eventFormVersions.id),
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    waitlistedAt: timestamp("waitlisted_at", { withTimezone: true }),
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    // Scan-out (points §4.2): set when student is scanned OUT; independent of check-in status field.
    checkedOutAt: timestamp("checked_out_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    checkedInByUserId: uuid("checked_in_by_user_id").references(() => users.id),
    checkedOutByUserId: uuid("checked_out_by_user_id").references(() => users.id),
    checkinMethod: checkinMethod("checkin_method"),
    manualCheckinReason: text("manual_checkin_reason"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("registrations_event_user_uq").on(t.eventId, t.userId),
    index("registrations_event_status_idx").on(t.eventId, t.status),
    index("registrations_user_idx").on(t.userId),
  ],
);

export const registrationFormAnswers = pgTable(
  "registration_form_answers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id),
    formVersionId: uuid("form_version_id")
      .notNull()
      .references(() => eventFormVersions.id),
    fieldKey: text("field_key").notNull(),
    value: jsonb("value"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("reg_answers_reg_field_uq").on(t.registrationId, t.fieldKey)],
);

export type Registration = typeof registrations.$inferSelect;
export type NewRegistration = typeof registrations.$inferInsert;
