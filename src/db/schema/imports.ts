import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";
import { importStatus } from "./enums";
import { users } from "./users";

// Tracks an import batch for the import-result endpoint. (Inferred, not in spec — confirmed with Boss.)
export const userImports = pgTable("user_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  adminId: uuid("admin_id")
    .notNull()
    .references(() => users.id),
  filename: text("filename").notNull(),
  scope: text("scope").notNull(), // user_pool_only | user_pool_and_register_to_event
  targetEventId: uuid("target_event_id").references(() => events.id),
  status: importStatus("status").notNull().default("pending"),
  resultSummary: jsonb("result_summary"), // counts + per-row outcomes
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserImport = typeof userImports.$inferSelect;
