import { pgEnum } from "drizzle-orm/pg-core";

// Central enum definitions — referenced across tables.
export const userRole = pgEnum("user_role", ["student", "checkin_staff", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);

export const eventStatus = pgEnum("event_status", ["draft", "published", "cancelled", "archived"]);
export const eventVisibility = pgEnum("event_visibility", ["listed", "unlisted"]);
export const registrationMode = pgEnum("registration_mode", [
  "public_self_register",
  "admin_import_only",
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

export const importStatus = pgEnum("import_status", [
  "pending",
  "previewed",
  "confirmed",
  "failed",
]);
