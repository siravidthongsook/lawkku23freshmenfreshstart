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

// POST /api/events/:eventId/checkins/scan — server returns the outcome code (+ optional registrationId).
// NOTE: backend currently returns only { result, registrationId } — name/student_id/time are NOT in the
// scan payload. We render whatever the server includes; success detail fields are optional/best-effort.
export type ScanResponse = {
  result: ScanResultCode;
  registrationId?: string;
  // Optional enrichment if the backend later adds it to the success payload — render when present.
  fullName?: string | null;
  studentId?: string | null;
  checkedInAt?: string | null;
  checkedInBy?: string | null;
  originalCheckedInAt?: string | null;
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
