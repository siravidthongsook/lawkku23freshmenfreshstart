import {
  boolean,
  integer,
  jsonb,
  pgTable,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { formType } from "./enums";
import { events } from "./events";
import { users } from "./users";

// Versioned form schema. New version on structural change after submissions exist.
// formType discriminates the registration form from the separate assessment form (plan §3.1b) —
// an event can hold ONE active version of each type at once.
export const eventFormVersions = pgTable(
  "event_form_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    // default 'registration' so every existing row/caller keeps its current meaning (expand-only migration).
    formType: formType("form_type").notNull().default("registration"),
    versionNumber: integer("version_number").notNull(),
    schemaJson: jsonb("schema_json").notNull(), // FormSchema (see lib/forms types)
    createdByAdminId: uuid("created_by_admin_id")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    isActive: boolean("is_active").notNull().default(true),
  },
  (t) => [
    // At most one active version per (event, formType) — one active registration form AND one
    // active assessment form can coexist (DB-enforced, defeats races).
    uniqueIndex("event_form_versions_one_active_uq")
      .on(t.eventId, t.formType)
      .where(sql`is_active`),
    // version_number must be unique per (event, formType) — each type has its own version sequence.
    unique("event_form_versions_event_version_uq").on(t.eventId, t.formType, t.versionNumber),
  ],
);

export type EventFormVersion = typeof eventFormVersions.$inferSelect;
