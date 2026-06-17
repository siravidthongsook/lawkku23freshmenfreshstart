import { boolean, integer, jsonb, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";
import { users } from "./users";

// Versioned form schema. New version on structural change after submissions exist.
export const eventFormVersions = pgTable("event_form_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  eventId: uuid("event_id")
    .notNull()
    .references(() => events.id),
  versionNumber: integer("version_number").notNull(),
  schemaJson: jsonb("schema_json").notNull(), // FormSchema (see lib/forms types)
  createdByAdminId: uuid("created_by_admin_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  isActive: boolean("is_active").notNull().default(true),
});

export type EventFormVersion = typeof eventFormVersions.$inferSelect;
