import { z } from "zod";

const roleEnum = z.enum(["student", "checkin_staff", "admin"]);
const statusEnum = z.enum(["active", "disabled"]);

// Sortable columns for the user list. Maps 1:1 to a users column in routes.ts.
const userSortEnum = z.enum([
  "created_at",
  "last_active_at",
  "full_name",
  "student_id",
  "email",
  "username",
  "status",
]);

// List/search filter for GET /admin/users. limit/offset paginate like audit-logs.
export const listUsersQuery = z.object({
  q: z.string().trim().min(1).optional(), // matches email / student_id / username / full_name
  role: roleEnum.optional(),
  status: statusEnum.optional(),
  // Claim filter: "yes" = password set, "no" = not yet claimed (passwordHash NULL). Omit = all.
  claimed: z.enum(["yes", "no"]).optional(),
  sort: userSortEnum.default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Allow-listed CSV export columns (stable order). Secrets (password_hash / temp-pw / tokens) are
// NEVER in this list — there is no way to request them. `columns` param intersects with this set.
export const USER_EXPORT_COLUMNS = [
  "student_id",
  "full_name",
  "email",
  "username",
  "role",
  "status",
  "group_number",
  "faculty",
  "department",
  "phone",
  "instagram",
  "claimed",
  "pending_temp_pw",
  "created_at_bangkok",
  "last_active_at_bangkok",
] as const;
export type UserExportColumn = (typeof USER_EXPORT_COLUMNS)[number];
const EXPORT_COLUMN_SET = new Set<string>(USER_EXPORT_COLUMNS);

// BKK-local calendar date (YYYY-MM-DD) — converted to UTC bounds in the query builder.
const bkkDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Export filter = the list filters (sans pagination/sort) + extra export-only narrowing + columns.
export const exportUsersQuery = z.object({
  q: z.string().trim().min(1).optional(),
  role: roleEnum.optional(),
  status: statusEnum.optional(),
  claimed: z.enum(["yes", "no"]).optional(),
  // pending_temp_pw: yes = admin issued a temp pw not yet consumed; no = none pending.
  pending_temp_pw: z.enum(["yes", "no"]).optional(),
  // group_number (บรรพ) 1..16.
  group_number: z.coerce.number().int().min(1).max(16).optional(),
  created_from: bkkDate.optional(),
  created_to: bkkDate.optional(),
  // never_active=true filters users who have never been seen since launch (lastActiveAt NULL).
  never_active: z.preprocess((v) => v === "true" || v === true, z.boolean()).optional(),
  // Comma-separated subset of USER_EXPORT_COLUMNS; unknown keys ignored. Omit = all columns.
  columns: z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(",")
            .map((s) => s.trim())
            .filter((s) => EXPORT_COLUMN_SET.has(s))
        : undefined,
    z.array(z.enum(USER_EXPORT_COLUMNS)).min(1).optional(),
  ),
});

export type ExportUsersQuery = z.infer<typeof exportUsersQuery>;

// How a new/reset account gets its first password:
//  - temp_password: admin-issued temp pw (hash set now, must_change=true) — user logs in + changes it.
//  - claim: NO password (passwordHash NULL) — user self-claims at /claim with their identifier.
export const provisionModeEnum = z.enum(["temp_password", "claim"]);

// Create user — temp password is generated server-side, never accepted from client.
// Students MUST have a student_id (they log in with email OR student_id).
export const createUserSchema = z
  .object({
    // Email optional: claim users may have none (login via student_id). Blank string -> undefined.
    email: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
      z.string().trim().toLowerCase().email().optional() // normalize -> case-insensitive login match
    ),
    student_id: z.string().trim().min(1).optional(),
    role: roleEnum,
    full_name: z.string().trim().min(1),
    faculty: z.string().trim().optional(),
    department: z.string().trim().optional(),
    phone: z.string().trim().optional(),
    provision_mode: provisionModeEnum.default("temp_password"),
  })
  .refine((v) => v.role !== "student" || !!v.student_id, {
    message: "student_id is required for students",
    path: ["student_id"],
  })
  // Claim matches on student_id/username only — a claimable account needs an identifier to claim with.
  .refine((v) => v.provision_mode !== "claim" || !!v.student_id, {
    message: "student_id is required for claim-mode accounts",
    path: ["student_id"],
  })
  // Temp-password accounts still need an email to receive/use their issued login.
  .refine((v) => v.provision_mode === "claim" || !!v.email, {
    message: "email is required for temp-password accounts",
    path: ["email"],
  });

// Edit profile — all optional; email/student_id must stay unique.
export const updateUserSchema = z
  .object({
    // Email nullable: claim users have none. Blank string -> null (clears it).
    email: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().toLowerCase().email().nullable().optional(),
    ),
    student_id: z.string().trim().min(1).nullable().optional(),
    // Staff login id (e.g. staff-01); blank string -> null (clears). Stays unique like email/student_id.
    // Lowercased to match the seed (staff-NN) so admin edits never silently break exact-match login.
    username: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().toLowerCase().min(1).nullable().optional(),
    ),
    full_name: z.string().trim().min(1).optional(),
    faculty: z.string().trim().nullable().optional(),
    department: z.string().trim().nullable().optional(),
    phone: z.string().trim().nullable().optional(),
    // IG handle — collected at claim; admin-editable. Blank string -> null (clears).
    instagram: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.string().trim().nullable().optional(),
    ),
    // บรรพ — int cohort number; blank string -> null (clears). Coerce so "" / numeric strings both work.
    group_number: z.preprocess(
      (v) => (typeof v === "string" && v.trim() === "" ? null : v),
      z.coerce.number().int().nullable().optional(),
    ),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

// Reason-required mutations.
export const reasonSchema = z.object({ reason: z.string().trim().min(1) });
// Reset password — same reason gate, plus the provisioning mode (temp pw vs reset-to-claim).
export const resetPasswordSchema = reasonSchema.extend({
  mode: provisionModeEnum.default("temp_password"),
});
export const changeRoleSchema = z.object({ role: roleEnum, reason: z.string().trim().min(1) });

export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
