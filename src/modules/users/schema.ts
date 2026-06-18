import { z } from "zod";

const roleEnum = z.enum(["student", "checkin_staff", "admin"]);
const statusEnum = z.enum(["active", "disabled"]);

// List/search filter for GET /admin/users. limit/offset paginate like audit-logs.
export const listUsersQuery = z.object({
  q: z.string().trim().min(1).optional(), // matches email / student_id / full_name
  role: roleEnum.optional(),
  status: statusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Create user — temp password is generated server-side, never accepted from client.
// Students MUST have a student_id (they log in with email OR student_id).
export const createUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email(), // normalize -> case-insensitive login match
    student_id: z.string().trim().min(1).optional(),
    role: roleEnum,
    full_name: z.string().trim().min(1),
    faculty: z.string().trim().optional(),
    department: z.string().trim().optional(),
    phone: z.string().trim().optional(),
  })
  .refine((v) => v.role !== "student" || !!v.student_id, {
    message: "student_id is required for students",
    path: ["student_id"],
  });

// Edit profile — all optional; email/student_id must stay unique.
export const updateUserSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(), // normalize -> case-insensitive login match
    student_id: z.string().trim().min(1).nullable().optional(),
    full_name: z.string().trim().min(1).optional(),
    faculty: z.string().trim().nullable().optional(),
    department: z.string().trim().nullable().optional(),
    phone: z.string().trim().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

// Reason-required mutations.
export const reasonSchema = z.object({ reason: z.string().trim().min(1) });
export const changeRoleSchema = z.object({ role: roleEnum, reason: z.string().trim().min(1) });

export type ListUsersQuery = z.infer<typeof listUsersQuery>;
export type CreateUserInput = z.infer<typeof createUserSchema>;
export type UpdateUserInput = z.infer<typeof updateUserSchema>;
