// Frontend-only response shapes inferred from docs/02-api-contract.md + docs/03-page-list.md.
// Backend does not yet export these response types — ALIGN these when backend exported shapes land.
// All timestamp fields are ISO-8601 UTC strings over the wire (render via @/lib/time).

import type { FormSchema } from "@/lib/schemas";

export type Role = "student" | "checkin_staff" | "admin";
export type EventStatus = "draft" | "published" | "cancelled" | "archived";
export type EventVisibility = "listed" | "unlisted";
export type RegistrationMode = "public_self_register" | "closed";
export type RegistrationStatus = "registered" | "waitlisted" | "checked_in" | "cancelled";
// Origin of a registration (matches the backend `registration_source` enum).
export type RegistrationSource = "normal" | "walkin";

// GET /auth/me — current user + forced-change flag.
export type Me = {
  id: string;
  email: string;
  studentId: string | null;
  fullName: string;
  faculty: string | null;
  department: string | null;
  phone: string | null;
  groupNumber: number | null; // บรรพ — admin-managed
  role: Role;
  status: "active" | "disabled";
  passwordMustChange: boolean;
  studentPointsVisible: boolean; // admin switch — false hides the points/peer/leaderboard nav for students
};

// Public event (GET /events, GET /events/:slug). Capacity numbers omitted when capacity disabled.
export type EventPublic = {
  id: string;
  publicId: string;
  publicSlug: string;
  title: string;
  description: string | null;
  location: string | null;
  // Uploaded poster path WITHOUT /api prefix (e.g. "/events/{publicId}/poster"); null → fall back to gallery image.
  posterImageUrl: string | null;
  status: EventStatus;
  visibility: EventVisibility;
  registrationMode: RegistrationMode;
  registrationOpenAt: string | null;
  registrationCloseAt: string | null;
  checkinOpenAt: string | null;
  checkinCloseAt: string | null;
  eventStartAt: string | null;
  eventEndAt: string | null;
  capacityEnabled: boolean;
  capacityLimit: number | null;
  registeredCount: number;
  waitlistEnabled: boolean;
  // OPTIONAL active registration form. Backend MAY include it; tolerant shape (bare schema or {schema}).
  // When present with fields, the public register flow must collect answers. Absent → formless register.
  form?: { version?: number; schema: FormSchema } | FormSchema | null;
  // OPTIONAL: present only for an authenticated viewer who already has a non-cancelled registration.
  myRegistrationId?: string | null;
  myRegistrationStatus?: RegistrationStatus | null;
};

// Admin event row (GET /admin/events) — superset incl. cancel/edit config + counts.
export type EventAdmin = EventPublic & {
  registeredCount: number;
  checkedInCount: number;
  cancelledCount: number;
  waitlistedCount: number;
  allowStudentCancelRegistration: boolean;
  cancelRegistrationCloseAt: string | null;
  allowStudentEditRegistration: boolean;
  editRegistrationCloseAt: string | null;
  createdAt: string;
  updatedAt: string;
};

// Row in the admin event registration list (GET /admin/events/:id/registrations).
// Enriched server-side with user identity, the check-in actor's name, and the form version number.
export type RegistrationListItem = {
  id: string;
  eventId: string;
  userId: string;
  status: RegistrationStatus;
  registrationSource: RegistrationSource; // origin of the reg: ปกติ vs Walk-in
  formVersionId: string | null;
  studentId: string | null;
  fullName: string | null;
  email: string | null;
  faculty: string | null;
  department: string | null;
  registeredAt: string | null;
  waitlistedAt: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  cancelledAt: string | null;
  checkinMethod: string | null;
  checkedInBy: string | null; // full name of staff/admin who checked them in
  checkedOutBy: string | null; // full name of staff/admin who checked them out
  formVersion: number | null; // human-friendly version number
};

// User row (GET /admin/users).
export type UserListItem = {
  id: string;
  email: string;
  studentId: string | null;
  fullName: string;
  faculty: string | null;
  department: string | null;
  phone: string | null;
  role: Role;
  status: "active" | "disabled";
  passwordMustChange: boolean;
  createdAt: string;
};

// Scan result codes — see docs/02 §Check-in. UI maps each to a success/deny/error treatment.
// Per-event check-OUT availability for staff UI badges. "disabled" = toggle off OR no resolvable
// scan-out window (event has no check-out). before/open/closed = window timing relative to now.
export type CheckoutState = "disabled" | "before" | "open" | "closed";

export type ScanResultCode =
  | "checked_in_success"
  | "already_checked_in"
  // Scan-OUT outcomes (§4.2) — surfaced on the checkout scanner.
  | "checked_out_success"
  | "already_checked_out"
  | "not_checked_in" // scan-out attempted before a check-in exists
  | "scan_window_closed" // outside the scan-out window
  | "points_closed" // past the leaderboard cutoff
  | "checkout_disabled" // event's check-out toggle is off
  | "wrong_event"
  | "registration_cancelled"
  | "waitlisted_not_allowed"
  | "checkin_not_open"
  | "checkin_closed"
  | "event_not_published"
  | "event_cancelled"
  | "qr_revoked"
  | "qr_invalid"
  | "network_error" // UI-only: thrown ApiError / non-2xx / offline. Never a success.
  | "processing"; // UI-only: scan sent, awaiting server. Blanks the previous result so it can't be mistaken.

// Import row status — mirrors backend ROW_STATUSES (kept here for UI without importing server-only code).
export type ImportRowStatus =
  | "will_create"
  | "will_update"
  | "invalid"
  | "duplicate_email"
  | "duplicate_student_id"
  | "will_register_over_capacity";
