import { z } from "zod";

// Login: identifier (email OR student_id) + password. Generic failure handling in handler (no enumeration).
export const loginSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
});

// Claim: imported (email-less) users prove identity with identifier alone, then set first password.
// identifier = student_id (students) OR username e.g. staff-01 (staff). Policy enforced in handler.
export const claimSchema = z.object({
  identifier: z.string().trim().min(1),
  new_password: z.string().min(1),
});

// Change-password: only need the new password; policy enforced via validatePasswordPolicy.
export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(1),
});

// Self-edit own profile (PATCH /auth/me). All optional; email stays unique.
// student_id + role deliberately excluded — those stay admin-only (identity/privilege).
export const updateOwnProfileSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(), // normalize -> case-insensitive login match
    full_name: z.string().trim().min(1).optional(),
    faculty: z.string().trim().nullable().optional(),
    department: z.string().trim().nullable().optional(),
    phone: z.string().trim().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "No fields to update" });

export type LoginInput = z.infer<typeof loginSchema>;
export type ClaimInput = z.infer<typeof claimSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
export type UpdateOwnProfileInput = z.infer<typeof updateOwnProfileSchema>;
