// Staff-local response shapes for the check-in surface — inferred from src/modules/checkins/routes.ts.
// Kept here (not lib/types.ts, which is shared/owned elsewhere) so the staff tree owns its contract.
// ALIGN with backend exported types when they land. All timestamps are ISO-8601 UTC (render via @/lib/time).

import type { RegistrationStatus, ScanResultCode, CheckoutState } from "@/lib/types";

// GET /api/staff/events — check-in-capable events globally.
export type StaffEventListItem = {
  id: string;
  title: string;
  location: string | null;
  checkinOpenAt: string | null;
  checkinCloseAt: string | null;
  checkinOpen: boolean;
  checkoutState?: CheckoutState; // check-out badge state (absent on older backend → treat as disabled)
  // Counts are documented in the page-list but may be absent from the backend payload — tolerate.
  registeredCount?: number;
  checkedInCount?: number;
  status?: string;
  eventStartAt?: string | null;
};

export type StaffEventListResponse = { events: StaffEventListItem[] };

// GET /api/staff/events/:eventId/checkin — scanner context + counts.
export type StaffCheckinContext = {
  event: {
    id: string;
    title: string;
    status: string;
    checkinOpenAt: string | null;
    checkinCloseAt: string | null;
    checkinOpen: boolean;
    checkoutState?: CheckoutState; // OUT scanner header badge
    scanOutOpenAt?: string | null;
    scanOutCloseAt?: string | null;
    location?: string | null;
  };
  counts: { registered: number; checkedIn: number; checkedOut?: number };
};

// POST /api/events/:eventId/checkins/scan — server returns the outcome code + identity for every
// reg-bearing outcome (so staff confirm WHO at a fast gate). Scanner-minimal: name + student_id only.
export type ScanResponse = {
  result: ScanResultCode;
  registrationId?: string;
  fullName?: string | null;
  studentId?: string | null;
  status?: RegistrationStatus; // current reg status (on the "ready" preview, drives the confirm dialog)
  checkedInAt?: string | null;
  checkedOutAt?: string | null;
  checkedInBy?: string | null;
  originalCheckedInAt?: string | null;
  pointsAwarded?: number; // "+N" surfaced on success
};

// dry-run resolve response: same shape as ScanResponse but result may be "ready" (all checks pass,
// awaiting staff confirm). "ready" never reaches ScanResultPanel — the page turns it into a confirm dialog.
export type ScanPreviewResponse = Omit<ScanResponse, "result"> & {
  result: ScanResultCode | "ready";
};

// Display wrapper: `seq` is a per-scan counter so the result card remounts (re-fires the pop animation)
// even on identical back-to-back outcomes, and the recent strip can key items stably.
export type DisplayScan = ScanResponse & { seq: number };

// One row in the recent-scans strip. `at` = client-captured Bangkok time string for the strip only.
export type RecentScan = {
  seq: number;
  code: ScanResultCode;
  fullName: string | null;
  studentId: string | null;
  at: string;
};

// GET /api/events/:eventId/checkins/search — minimal, scanner-safe projection (no email/phone/answers/files).
export type CheckinSearchResult = {
  registrationId: string;
  status: RegistrationStatus;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  studentId: string | null;
  fullName: string;
  faculty: string | null;
  department: string | null;
};

export type CheckinSearchResponse = { results: CheckinSearchResult[] };

// POST /api/registrations/:id/manual-checkin — returns authoritative server check-in time.
export type ManualCheckinResponse = { result: "checked_in_success"; checkedInAt: string };

// POST /api/registrations/:id/manual-checkout — returns authoritative server check-out time.
export type ManualCheckoutResponse = { result: "checked_out_success"; checkedOutAt: string };
