// Small adapters that absorb backend-shape uncertainty for the student registration detail.
import { formSchema, type FormSchema } from "@/lib/schemas";
import type { RegistrationDetailResponse } from "@/components/student/types";

// The detail's `form` may be a bare FormSchema, a { schema } wrapper, or absent. Returns a validated
// schema or null. Returning null lets the edit page show a clear "form unavailable" state.
export function extractFormSchema(detail: RegistrationDetailResponse): FormSchema | null {
  const raw = detail.form;
  if (!raw) return null;
  const candidate = "schema" in raw ? raw.schema : raw;
  const parsed = formSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// Best-effort display title: backend enrichment first, else a stable fallback.
export function displayTitle(detail: RegistrationDetailResponse): string {
  return (
    detail.event?.title ??
    detail.registration.eventTitle ??
    "การลงทะเบียนกิจกรรม"
  );
}

// Whether the student edit action should be offered, given backend-provided flags + deadline + status.
// Conservative: if the backend did not send the config, we still SHOW the action and let the backend
// be the source of truth (it rejects on submit) — but we always hide it for checked_in/cancelled.
export function canOfferEdit(detail: RegistrationDetailResponse): boolean {
  const s = detail.registration.status;
  if (s === "checked_in" || s === "cancelled" || s === "waitlisted") return false;
  const ev = detail.event;
  if (ev?.allowStudentEditRegistration === false) return false;
  if (ev?.editRegistrationCloseAt && new Date() > new Date(ev.editRegistrationCloseAt)) return false;
  return true;
}

// Human reason the edit action is unavailable — so the edit page can explain instead of a generic message.
// Returns null when editing IS allowed. Mirrors canOfferEdit's checks, in the same precedence order.
export function editDisallowedReason(detail: RegistrationDetailResponse): string | null {
  const s = detail.registration.status;
  if (s === "checked_in") return "คุณเช็คอินกิจกรรมนี้แล้ว จึงไม่สามารถแก้ไขคำตอบได้";
  if (s === "cancelled") return "การลงทะเบียนนี้ถูกยกเลิกแล้ว จึงไม่สามารถแก้ไขคำตอบได้";
  if (s === "waitlisted") return "คุณอยู่ในรายชื่อสำรอง จึงยังแก้ไขคำตอบไม่ได้ในขณะนี้";
  const ev = detail.event;
  if (ev?.allowStudentEditRegistration === false)
    return "ผู้จัดกิจกรรมไม่อนุญาตให้แก้ไขคำตอบหลังลงทะเบียน";
  if (ev?.editRegistrationCloseAt && new Date() > new Date(ev.editRegistrationCloseAt))
    return "หมดเวลาที่อนุญาตให้แก้ไขคำตอบแล้ว";
  return null;
}

// Whether the student cancel action should be offered. Same conservative philosophy as edit.
export function canOfferCancel(detail: RegistrationDetailResponse): boolean {
  const s = detail.registration.status;
  if (s === "checked_in" || s === "cancelled") return false;
  const ev = detail.event;
  if (ev?.allowStudentCancelRegistration === false) return false;
  if (ev?.cancelRegistrationCloseAt && new Date() > new Date(ev.cancelRegistrationCloseAt))
    return false;
  return true;
}
