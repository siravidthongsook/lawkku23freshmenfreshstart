// Cross-field time-ordering rules for an event timeline. Single source of truth — imported by the
// backend handlers (defense at the API boundary) AND the admin form (inline errors) via @be/*.
// Each rule fires ONLY when both operands are present, so legitimately-omitted timestamps are fine.
// Field names match the form's data-field attrs so the UI can scroll to the offending input.

export type TimingViolation = { field: string; message: string };

// Event-table timestamps (the same-table ordering group).
export type EventTiming = {
  registrationOpenAt: Date | null;
  registrationCloseAt: Date | null;
  checkinOpenAt: Date | null;
  checkinCloseAt: Date | null;
  eventStartAt: Date | null;
  eventEndAt: Date | null;
};

// Point-config windows (separate table) validated against the event's start/end.
export type PointWindowTiming = {
  scanOutOpenAt: Date | null;
  scanOutCloseAt: Date | null;
  assessmentOpenAt: Date | null; // null = auto-open at eventStartAt
  assessmentCloseAt: Date | null;
};

// Same-table event ordering: registration ⊂ before event, scan-in (check-in) ⊂ before/at event end.
export function validateEventTiming(t: EventTiming): TimingViolation[] {
  const v: TimingViolation[] = [];
  if (t.eventStartAt && t.eventEndAt && t.eventStartAt >= t.eventEndAt)
    v.push({ field: "eventEndAt", message: "เวลาสิ้นสุดกิจกรรมต้องอยู่หลังเวลาเริ่มกิจกรรม" });
  if (t.registrationOpenAt && t.registrationCloseAt && t.registrationOpenAt >= t.registrationCloseAt)
    v.push({ field: "registrationCloseAt", message: "เวลาปิดลงทะเบียนต้องอยู่หลังเวลาเปิดลงทะเบียน" });
  if (t.checkinOpenAt && t.checkinCloseAt && t.checkinOpenAt >= t.checkinCloseAt)
    v.push({ field: "checkinCloseAt", message: "เวลาปิดสแกนเข้าต้องอยู่หลังเวลาเปิดสแกนเข้า" });
  // Scan-in must not outlast the event (hands off to scan-out at event end).
  if (t.checkinCloseAt && t.eventEndAt && t.checkinCloseAt > t.eventEndAt)
    v.push({ field: "checkinCloseAt", message: "เวลาปิดสแกนเข้าต้องไม่เกินเวลาจบงาน" });
  // Registration shouldn't stay open past the event's end.
  if (t.registrationCloseAt && t.eventEndAt && t.registrationCloseAt > t.eventEndAt)
    v.push({ field: "registrationCloseAt", message: "เวลาปิดลงทะเบียนต้องไม่เกินเวลาจบงาน" });
  return v;
}

// Point-window ordering vs the event: scan-out can't overlap scan-in (open ≥ effective check-in close),
// assessment close after its effective open (= override, else event start). Blank close = open forever.
export function validatePointWindowTiming(
  w: PointWindowTiming,
  event: Pick<EventTiming, "eventStartAt" | "eventEndAt" | "checkinCloseAt">,
): TimingViolation[] {
  const v: TimingViolation[] = [];
  if (w.scanOutOpenAt && w.scanOutCloseAt && w.scanOutOpenAt >= w.scanOutCloseAt)
    v.push({ field: "scanOutCloseAt", message: "เวลาปิดสแกนออกต้องอยู่หลังเวลาเปิดสแกนออก" });
  // Anti-overlap: scan-out opens only at/after scan-in closes. Effective scan-in close = explicit
  // checkinClose, else event end. So an early checkinClose lets scan-out open before the event ends.
  const effCheckinClose = event.checkinCloseAt ?? event.eventEndAt;
  if (w.scanOutOpenAt && effCheckinClose && w.scanOutOpenAt < effCheckinClose)
    v.push({ field: "scanOutOpenAt", message: "เวลาเปิดสแกนออกต้องไม่ก่อนเวลาปิดสแกนเข้า (กันช่วงสแกนซ้อนกัน)" });
  // Effective assessment open = override, else event start (auto-open). Only checked when a close is set.
  const assessOpen = w.assessmentOpenAt ?? event.eventStartAt;
  if (w.assessmentCloseAt && assessOpen && w.assessmentCloseAt <= assessOpen)
    v.push({ field: "assessmentCloseAt", message: "เวลาปิดแบบประเมินต้องอยู่หลังเวลาเปิด (เวลาเริ่มงาน)" });
  return v;
}
