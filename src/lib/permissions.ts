import type { AuthUser } from "./context";
import type { Registration } from "../db/schema/registrations";
import type { UploadedFile } from "../db/schema/files";

// Single source of role logic. NEVER inline `user.role === 'admin'` in handlers — call these.
const isAdmin = (u: AuthUser) => u.role === "admin";
const isStaff = (u: AuthUser) => u.role === "checkin_staff";
const isStudent = (u: AuthUser) => u.role === "student";

export const canManageUsers = (u: AuthUser) => isAdmin(u);
export const canManageEvents = (u: AuthUser) => isAdmin(u);
export const canExportRegistrations = (u: AuthUser) => isAdmin(u);
export const canResetPassword = (u: AuthUser) => isAdmin(u);
export const canViewAuditLogs = (u: AuthUser) => isAdmin(u);

// Check-in capabilities — staff or admin.
export const canScanCheckin = (u: AuthUser) => isStaff(u) || isAdmin(u);
export const canManualCheckin = (u: AuthUser) => isStaff(u) || isAdmin(u);

// Points/rewards — students only earn points & appear on the leaderboard (plan §6). Staff/admin have no balance.
export const canEarnPoints = (u: AuthUser) => isStudent(u);

// File download: student = own only, admin = all, staff = none.
export function canViewUploadedFile(u: AuthUser, file: Pick<UploadedFile, "ownerUserId">): boolean {
  if (isAdmin(u)) return true;
  if (isStaff(u)) return false;
  return file.ownerUserId === u.id; // student
}

// Admin always; student only on their own registration (further window/status gating in handler).
export function canEditRegistrationAnswer(
  u: AuthUser,
  reg: Pick<Registration, "userId">,
): boolean {
  if (isAdmin(u)) return true;
  return reg.userId === u.id;
}
