// Student-side response shapes. Defined here (not in @/lib/types, which is shared/locked) and kept
// TOLERANT: backend is built in parallel, so several fields the UI would like are OPTIONAL — the
// page handles their absence. Aligned to src/modules/registrations/serializeRegistration + route bodies.

import type { FormSchema, AnswerMap } from "@/lib/schemas";
import type { RegistrationStatus } from "@/lib/types";

// Bare registration row as returned by serializeRegistration() — NO event title/date enrichment.
export type StudentRegistration = {
  id: string;
  eventId: string;
  userId: string;
  status: RegistrationStatus;
  formVersionId: string | null;
  registeredAt: string | null;
  waitlistedAt: string | null;
  checkedInAt: string | null;
  cancelledAt: string | null;
  checkinMethod: string | null;
  createdAt: string;
  updatedAt: string;
  // OPTIONAL enrichment the backend MAY add later; the list/detail tolerate their absence.
  eventTitle?: string | null;
  eventStartAt?: string | null;
};

// GET /me/registrations
export type MyRegistrationsResponse = {
  registrations: StudentRegistration[];
};

// QR sub-object on the detail response. Backend returns eligible/available/publicEventId.
// `token` is OPTIONAL — backend does not currently expose a per-registration token to students;
// when absent we fall back to the event's permanent QR URL (/e/:publicEventId).
export type RegistrationQr = {
  eligible: boolean;
  available: boolean;
  publicEventId?: string | null;
  token?: string | null;
};

// GET /me/registrations/:id — registration + answers (field_key→value) + file ids + qr.
// `event` and `form` are OPTIONAL: backend may enrich the detail later. The page degrades gracefully.
export type RegistrationDetailResponse = {
  registration: StudentRegistration;
  answers: AnswerMap;
  fileIds: string[];
  qr: RegistrationQr;
  // OPTIONAL: event info for display (title/time/status) + whether edit/cancel are allowed right now.
  event?: {
    title?: string | null;
    description?: string | null;
    location?: string | null;
    status?: string | null;
    eventStartAt?: string | null;
    eventEndAt?: string | null;
    allowStudentCancelRegistration?: boolean;
    cancelRegistrationCloseAt?: string | null;
    allowStudentEditRegistration?: boolean;
    editRegistrationCloseAt?: string | null;
    publicSlug?: string | null;
  } | null;
  // OPTIONAL: the registration's OWN form version schema, needed by the edit page.
  form?: { schema: FormSchema } | FormSchema | null;
};
