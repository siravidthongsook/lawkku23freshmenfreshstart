import { z } from "zod";

// Login: identifier (email OR student_id) + password. Generic failure handling in handler (no enumeration).
export const loginSchema = z.object({
  identifier: z.string().trim().min(1),
  password: z.string().min(1),
});

// Change-password: only need the new password; policy enforced via validatePasswordPolicy.
export const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(1),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;
