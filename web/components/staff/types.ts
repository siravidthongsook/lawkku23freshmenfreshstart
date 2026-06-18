// Staff-local response shapes for the check-in surface — inferred from src/modules/checkins/routes.ts.
// Kept here (not lib/types.ts, which is shared/owned elsewhere) so the staff tree owns its contract.
// ALIGN with backend exported types when they land. All timestamps are ISO-8601 UTC (render via @/lib/time).

import type { RegistrationStatus, ScanResultCode } from "@/lib/types";

// GET /api/staff/events — check-in-capable events globally.
export type StaffEventListItem = {
  id: string;
  title: string;
  location: string | null;
  checkinOpenAt: string | null;
  checkinCloseAt: string | null;
  checkinOpen: boolean;
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
    location?: string | null;
  };
  counts: { registered: number; checkedIn: number };
};

// POST /api/events/:eventId/checkins/scan — server returns the outcome code + identity for every
// reg-bearing outcome (so staff confirm WHO at a fast gate). Scanner-minimal: name + student_id only.
export type ScanResponse = {
  result: ScanResultCode;
  registrationId?: string;
  fullName?: string | null;
  studentId?: string | null;
  checkedInAt?: string | null;
  checkedInBy?: string | null;
  originalCheckedInAt?: string | null;
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
  studentId: string | null;
  fullName: string;
  faculty: string | null;
  department: string | null;
};

export type CheckinSearchResponse = { results: CheckinSearchResult[] };

// POST /api/registrations/:id/manual-checkin — returns authoritative server check-in time.
export type ManualCheckinResponse = { result: "checked_in_success"; checkedInAt: string };
