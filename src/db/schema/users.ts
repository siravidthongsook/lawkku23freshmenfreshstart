import { boolean, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { userRole, userStatus } from "./enums";

// Internal identity + profile + auth state. Referenced everywhere by id (uuid) only.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").unique(), // nullable: imported users have no email (PG allows multiple NULLs)
  studentId: text("student_id").unique(), // business id for students; null for staff/admin
  username: text("username").unique(), // staff login id (e.g. staff-01); null for students/admins
  role: userRole("role").notNull(),
  fullName: text("full_name").notNull(),
  title: text("title"), // student honorific (e.g. นางสาว)
  nickname: text("nickname"), // mentor nickname
  year: integer("year"), // mentor study year
  mentorRole: text("mentor_role"), // mentor role free text (Thai)
  category: text("category"), // mentor raw category (group_mentor|staff); role is derived
  groupNumber: integer("group_number"), // group 1..16; null for admins. claim 2nd factor
  faculty: text("faculty"),
  department: text("department"),
  phone: text("phone"),
  instagram: text("instagram"), // collected at account claim (required there); replaces per-event IG form field

  passwordHash: text("password_hash"), // nullable: NULL = account not yet claimed
  passwordMustChange: boolean("password_must_change").notNull().default(false),
  status: userStatus("status").notNull().default("active"),
  createdByAdminId: uuid("created_by_admin_id"), // self-ref → users.id (nullable for seed admin)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Last authenticated request seen for this user; null until first activity. Throttled write in requireAuth.
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }),
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
