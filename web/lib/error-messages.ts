// Backend sends an error CODE; UI renders Thai. Single source for code→Thai copy.
// Unknown code → fall back to the backend message (still readable, just not localized).
import { ApiError } from "@/lib/api";

const ERROR_TH: Record<string, string> = {
  // generic
  request_failed: "ไม่สามารถดำเนินการได้ กรุณาลองใหม่",
  forbidden: "ไม่มีสิทธิ์ดำเนินการนี้",
  not_found: "ไม่พบข้อมูล",
  invalid_answers: "มีคำตอบที่ไม่ถูกต้อง",

  // admin check-in/out state override
  no_changes: "ไม่ได้เลือกการเปลี่ยนแปลงเช็คอิน/เช็คเอาท์",
  at_in_future: "ไม่สามารถตั้งเวลาเป็นอนาคตได้",
  checkin_blocked_status: "ตั้งเช็คอินไม่ได้ เพราะการลงทะเบียนถูกยกเลิกหรืออยู่ในรายชื่อสำรอง",
  checkout_without_checkin: "เช็คเอาท์ไม่ได้ เพราะยังไม่มีการเช็คอิน",
  checkout_before_checkin: "เวลาเช็คเอาท์ต้องไม่ก่อนเวลาเช็คอิน",
};

// Map any thrown error to Thai display text.
export function errorToThai(err: unknown): string {
  if (err instanceof ApiError) {
    return ERROR_TH[err.code] ?? err.message ?? "ไม่สามารถดำเนินการได้";
  }
  return "ไม่สามารถดำเนินการได้";
}

// Reasons points were withheld even though the stamp committed (axis:reason from the backend).
const POINTS_SKIP_TH: Record<string, string> = {
  points_closed: "ปิดการให้แต้มแล้ว (เลยกำหนด)",
  not_student: "ไม่ใช่นักศึกษา",
  checkin_in_disabled: "ปิดการให้แต้มเช็คอิน",
  checkin_out_disabled: "ปิดการให้แต้มเช็คเอาท์",
};
const AXIS_TH: Record<string, string> = { checkin_in: "เช็คอิน", checkin_out: "เช็คเอาท์" };

// "checkin_out:points_closed" → "เช็คเอาท์: ปิดการให้แต้มแล้ว (เลยกำหนด)"
export function pointsSkipToThai(entry: string): string {
  const [axis, reason] = entry.split(":");
  const a = AXIS_TH[axis] ?? axis;
  const r = POINTS_SKIP_TH[reason] ?? reason;
  return `${a}: ${r}`;
}
