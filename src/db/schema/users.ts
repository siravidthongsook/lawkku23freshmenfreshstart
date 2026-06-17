import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userRole, userStatus } from "./enums";

// Internal identity + profile + auth state. Referenced everywhere by id (uuid) only.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  studentId: text("student_id").unique(), // business id for students; null for staff/admin
  role: userRole("role").notNull(),
  fullName: text("full_name").notNull(),
  faculty: text("faculty"),
  department: text("department"),
  phone: text("phone"),
  passwordHash: text("password_hash").notNull(),
  passwordMustChange: boolean("password_must_change").notNull().default(false),
  status: userStatus("status").notNull().default("active"),
  createdByAdminId: uuid("created_by_admin_id"), // self-ref → users.id (nullable for seed admin)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Encrypted temp password kept ONLY until user changes password (enables re-export).
export const temporaryPasswords = pgTable("temporary_passwords", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id),
  encryptedTempPassword: text("encrypted_temp_password").notNull(), // encrypted, NOT the hash
  createdByAdminId: uuid("created_by_admin_id")
    .notNull()
    .references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
