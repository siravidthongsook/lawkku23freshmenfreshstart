import { index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";
import { eventFormVersions } from "./forms";
import { registrations } from "./registrations";
import { users } from "./users";

// Soft-delete + keep history. Private storage only — download via authorized endpoint.
export const uploadedFiles = pgTable(
  "uploaded_files",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id),
    formVersionId: uuid("form_version_id")
      .notNull()
      .references(() => eventFormVersions.id),
    formFieldKey: text("form_field_key").notNull(),
    originalFilename: text("original_filename").notNull(),
    storedObjectKey: text("stored_object_key").notNull(), // private storage key
    mimeType: text("mime_type").notNull(),
    fileSizeBytes: integer("file_size_bytes").notNull(),
    checksumSha256: text("checksum_sha256").notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    deletedReason: text("deleted_reason"), // replaced_by_user / replaced_by_admin
  },
  (t) => [index("uploaded_files_reg_idx").on(t.registrationId)],
);

export type UploadedFile = typeof uploadedFiles.$inferSelect;
