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
// Per-event point config + global point-settings/cutoff = admin only (plan §6). Config-editing endpoints land later;
// defined now so the award path can reference the same rule.
export const canManagePointConfig = (u: AuthUser) => isAdmin(u);

// Points adjust/grant (plan §6). Staff + admin can grant (give to students); staff draws from budget,
// admin is unlimited. Used by: grant-token issue, manual adjust (+), staff self-reverse window.
export const canAdjustPoints = (u: AuthUser) => isStaff(u) || isAdmin(u);
// Topping up / adjusting staff budget = admin only (admin is the budget source).
export const canTopupStaffBudget = (u: AuthUser) => isAdmin(u);
// Deducting points / reversing any ledger entry / freeform correction = admin only (plan §4.8).
export const canDeductPoints = (u: AuthUser) => isAdmin(u);
// Staff may reverse THEIR OWN recent manual-grant within the window; admin always can. The
// own-entry + reason-type + time-window checks are enforced in the handler (this only gates the route).
export const canReverseOwnRecentGrant = (u: AuthUser) => isStaff(u) || isAdmin(u);

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
