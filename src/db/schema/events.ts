import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { eventStatus, eventVisibility, registrationMode } from "./enums";
import { users } from "./users";

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  publicId: uuid("public_id").notNull().unique().defaultRandom(), // permanent QR URL target
  publicSlug: text("public_slug").notNull().unique(), // pretty URL, editable, no history
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  // Poster: posterImageUrl = render URL for cards (static path OR serve endpoint).
  // posterObjectKey = private storage key when uploaded; null when external/static (e.g. seed).
  posterImageUrl: text("poster_image_url"),
  posterObjectKey: text("poster_object_key"),
  status: eventStatus("status").notNull().default("draft"),
  visibility: eventVisibility("visibility").notNull().default("listed"),
  registrationMode: registrationMode("registration_mode").notNull().default("closed"),
  registrationOpenAt: timestamp("registration_open_at", { withTimezone: true }),
  registrationCloseAt: timestamp("registration_close_at", { withTimezone: true }),
  checkinOpenAt: timestamp("checkin_open_at", { withTimezone: true }),
  checkinCloseAt: timestamp("checkin_close_at", { withTimezone: true }),
  eventStartAt: timestamp("event_start_at", { withTimezone: true }),
  eventEndAt: timestamp("event_end_at", { withTimezone: true }),
  capacityEnabled: boolean("capacity_enabled").notNull().default(false),
  capacityLimit: integer("capacity_limit"),
  waitlistEnabled: boolean("waitlist_enabled").notNull().default(false),
  allowStudentCancelRegistration: boolean("allow_student_cancel_registration").notNull().default(false),
  cancelRegistrationCloseAt: timestamp("cancel_registration_close_at", { withTimezone: true }),
  allowStudentEditRegistration: boolean("allow_student_edit_registration").notNull().default(false),
  editRegistrationCloseAt: timestamp("edit_registration_close_at", { withTimezone: true }),
  createdByAdminId: uuid("created_by_admin_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
