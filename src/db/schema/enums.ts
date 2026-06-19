import { pgEnum } from "drizzle-orm/pg-core";

// Central enum definitions — referenced across tables.
export const userRole = pgEnum("user_role", ["student", "checkin_staff", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);

export const eventStatus = pgEnum("event_status", ["draft", "published", "cancelled", "archived"]);
export const eventVisibility = pgEnum("event_visibility", ["listed", "unlisted"]);
// admin_import_only removed: accounts are admin-provisioned, so self-register already implies "DB account only".
export const registrationMode = pgEnum("registration_mode", [
  "public_self_register",
  "closed",
]);

export const registrationStatus = pgEnum("registration_status", [
  "registered",
  "waitlisted",
  "checked_in",
  "cancelled",
]);
export const checkinMethod = pgEnum("checkin_method", ["qr_scan", "manual_search"]);

export const qrTokenStatus = pgEnum("qr_token_status", ["active", "revoked"]);

// Form kind per event — the existing registration form + a separate assessment form (plan §3.1).
export const formType = pgEnum("form_type", ["registration", "assessment"]);

export const importStatus = pgEnum("import_status", [
  "pending",
  "previewed",
  "confirmed",
  "failed",
]);

// Points/rewards — reason for each point_ledger entry (see plan §3.1).
export const pointReason = pgEnum("point_reason", [
  "checkin_in",
  "checkin_out",
  "assessment_completed",
  "staff_grant_qr", // student scans a staff grant QR
  "manual_adjust", // staff/admin manual give (+)
  "peer_connect", // scanner earns on connecting a peer
  "correction_add", // admin tops up a system miss (+)
  "correction_reverse", // admin reverses a wrong entry (negative delta)
]);

// Staff budget ledger reasons (budget tables land in a later phase; enum defined here per plan §3.1).
export const staffBudgetReason = pgEnum("staff_budget_reason", [
  "topup", // admin tops up budget (+)
  "grant_issue", // staff issues a grant QR (−)
  "grant_refund", // unused grant returned (+)
  "manual_grant", // staff manual give to student (−)
  "admin_adjust", // admin adjusts budget (+/−), reason required
]);
