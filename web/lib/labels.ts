// Central Thai label maps for enums/codes that would otherwise leak raw English/snake_case into the UI.
// Every helper falls back to the raw input when the key is unknown, so contract drift never crashes the UI.
// Enum values mirror src/db/schema/enums.ts and the imports/audit-logs modules — keep in sync if those change.

// ---- generic helper ----
// Look up a Thai label, falling back to the raw string when unmapped.
function lookup<K extends string>(map: Record<K, string>, key: string | null | undefined): string {
  if (key == null) return "—";
  return (map as Record<string, string>)[key] ?? key;
}

// ---- user role (user_role enum) ----
const ROLE: Record<string, string> = {
  admin: "ผู้ดูแลระบบ",
  checkin_staff: "เจ้าหน้าที่", // role now broader than check-in; DB value kept for compat
  student: "นักศึกษา",
};
export function roleLabel(r: string | null | undefined): string {
  return lookup(ROLE, r);
}

// ---- user status (user_status enum) ----
const USER_STATUS: Record<string, string> = {
  active: "บัญชีใช้ได้อยู่",
  disabled: "ถูกระงับ",
};
export function userStatusLabel(s: string | null | undefined): string {
  return lookup(USER_STATUS, s);
}

// ---- event status (event_status enum) ----
const EVENT_STATUS: Record<string, string> = {
  draft: "ฉบับร่าง",
  published: "เผยแพร่แล้ว",
  cancelled: "ยกเลิกแล้ว",
  archived: "เก็บถาวรแล้ว",
};
export function eventStatusLabel(s: string | null | undefined): string {
  return lookup(EVENT_STATUS, s);
}

// ---- event visibility (event_visibility enum) ----
const EVENT_VISIBILITY: Record<string, string> = {
  listed: "แสดงในรายการ",
  unlisted: "ไม่แสดงในรายการ",
};
export function eventVisibilityLabel(v: string | null | undefined): string {
  return lookup(EVENT_VISIBILITY, v);
}

// ---- computed event state (registration availability — see event-helpers.ts kinds + admin effectiveState) ----
const EVENT_STATE: Record<string, string> = {
  register: "เปิดรับลงทะเบียน",
  open: "เปิดรับลงทะเบียน",
  waitlist: "รับเฉพาะรายชื่อสำรอง",
  full: "เต็มแล้ว",
  not_open: "ยังไม่เปิดลงทะเบียน",
  closed: "ปิดรับลงทะเบียน",
  closed_mode: "ปิดรับลงทะเบียน",
  already_registered: "ลงทะเบียนแล้ว",
  cancelled: "ยกเลิกแล้ว",
  archived: "เก็บถาวรแล้ว",
  unavailable: "ไม่พร้อมให้ลงทะเบียน",
};
export function eventStateLabel(s: string | null | undefined): string {
  return lookup(EVENT_STATE, s);
}

// ---- registration mode (registration_mode enum) ----
const REG_MODE: Record<string, string> = {
  public_self_register: "ลงทะเบียนเองแบบสาธารณะ",
  closed: "ปิดรับลงทะเบียน",
};
export function regModeLabel(m: string | null | undefined): string {
  return lookup(REG_MODE, m);
}

// ---- registration status (registration_status enum) ----
const REG_STATUS: Record<string, string> = {
  registered: "ลงทะเบียนแล้ว",
  waitlisted: "อยู่ในรายชื่อสำรอง",
  checked_in: "เช็คอินแล้ว",
  cancelled: "ยกเลิกแล้ว",
};
export function regStatusLabel(s: string | null | undefined): string {
  return lookup(REG_STATUS, s);
}

// ---- check-in method (checkin_method enum) ----
const CHECKIN_METHOD: Record<string, string> = {
  qr_scan: "สแกน QR",
  manual_search: "ค้นหาด้วยตนเอง",
};
export function checkinMethodLabel(m: string | null | undefined): string {
  return lookup(CHECKIN_METHOD, m);
}

// ---- QR token status (qr_token_status enum) ----
const QR_STATUS: Record<string, string> = {
  active: "ใช้งานอยู่",
  revoked: "ถูกเพิกถอน",
};
export function qrStatusLabel(s: string | null | undefined): string {
  return lookup(QR_STATUS, s);
}

// ---- import per-row status (ROW_STATUSES, src/modules/imports/schema.ts) ----
// Mirrors web/components/admin-tools/row-status-badge.tsx — kept here so non-badge contexts can label rows too.
const IMPORT_ROW_STATUS: Record<string, string> = {
  will_create: "จะสร้างใหม่",
  will_update: "จะอัปเดต",
  will_register_over_capacity: "เกินจำนวนที่รับ",
  invalid: "ไม่ถูกต้อง",
  duplicate_email: "อีเมลซ้ำ",
  duplicate_student_id: "รหัสนักศึกษาซ้ำ",
};
export function importRowStatusLabel(s: string | null | undefined): string {
  return lookup(IMPORT_ROW_STATUS, s);
}

// ---- import preview/result count keys (service.ts buildCounts — row statuses + total) ----
// Covers both preview ("will_*") and confirm-result aggregate keys the backend may emit.
const IMPORT_COUNT: Record<string, string> = {
  total: "ทั้งหมด",
  will_create: "จะสร้างใหม่",
  will_update: "จะอัปเดต",
  will_register: "จะลงทะเบียน",
  will_register_over_capacity: "เกินจำนวนที่รับ",
  will_skip: "จะข้าม",
  invalid: "ไม่ถูกต้อง",
  duplicate_email: "อีเมลซ้ำ",
  duplicate_student_id: "รหัสนักศึกษาซ้ำ",
  errors: "ข้อผิดพลาด",
  skipped: "ข้ามแล้ว",
  created: "สร้างแล้ว",
  updated: "อัปเดตแล้ว",
  registered: "ลงทะเบียนแล้ว",
};
export function importCountLabel(k: string | null | undefined): string {
  return lookup(IMPORT_COUNT, k);
}

// ---- import status (import_status enum) ----
const IMPORT_STATUS: Record<string, string> = {
  pending: "รอดำเนินการ",
  previewed: "ดูตัวอย่างแล้ว",
  confirmed: "ยืนยันแล้ว",
  failed: "ล้มเหลว",
};
export function importStatusLabel(s: string | null | undefined): string {
  return lookup(IMPORT_STATUS, s);
}

// ---- audit action names (action literals across src/modules + src/lib/audit) ----
const AUDIT_ACTION: Record<string, string> = {
  // auth / account
  login_succeeded: "เข้าสู่ระบบสำเร็จ",
  login_failed_rate_limited: "ถูกจำกัดอัตราการเข้าสู่ระบบ",
  account_temporarily_locked: "บัญชีถูกล็อกชั่วคราว",
  admin_unlocked_account: "ผู้ดูแลปลดล็อกบัญชี",
  admin_password_reset: "ผู้ดูแลรีเซ็ตรหัสผ่าน",
  password_changed: "เปลี่ยนรหัสผ่าน",
  temp_password_revealed: "เปิดเผยรหัสผ่านชั่วคราว",
  temp_password_exported: "ส่งออกรหัสผ่านชั่วคราว",
  // users
  user_created: "สร้างผู้ใช้",
  user_disabled: "ระงับผู้ใช้",
  user_enabled: "เปิดใช้งานผู้ใช้",
  user_role_changed: "เปลี่ยนบทบาทผู้ใช้",
  user_profile_updated: "แก้ไขข้อมูลผู้ใช้",
  user_self_profile_updated: "ผู้ใช้แก้ไขข้อมูลตนเอง",
  users_imported: "นำเข้าผู้ใช้",
  // events
  event_status_changed: "เปลี่ยนสถานะกิจกรรม",
  event_visibility_changed: "เปลี่ยนการแสดงผลกิจกรรม",
  event_slug_changed: "เปลี่ยน slug กิจกรรม",
  event_poster_uploaded: "อัปโหลดโปสเตอร์กิจกรรม",
  form_version_created: "สร้างฟอร์มเวอร์ชันใหม่",
  // registrations
  registration_created: "สร้างการลงทะเบียน",
  registration_cancelled: "ยกเลิกการลงทะเบียน",
  registration_promoted: "เลื่อนจากรายชื่อสำรอง",
  registration_demoted: "ย้ายไปรายชื่อสำรอง",
  registration_answers_edited: "แก้ไขคำตอบการลงทะเบียน",
  admin_edit_registration_answer: "ผู้ดูแลแก้ไขคำตอบการลงทะเบียน",
  admin_register_over_capacity: "ผู้ดูแลลงทะเบียนเกินจำนวนที่รับ",
  registration_exported: "ส่งออกการลงทะเบียน",
  // check-in / qr
  qr_scan_checkin: "เช็คอินด้วยการสแกน QR",
  manual_checkin: "เช็คอินด้วยตนเอง",
  manual_checkin_undo: "ยกเลิกการเช็คอินด้วยตนเอง",
  qr_regenerated: "สร้าง QR ใหม่",
  qr_revoked: "เพิกถอน QR",
  // files
  uploaded_file_added: "เพิ่มไฟล์ที่อัปโหลด",
  uploaded_file_downloaded: "ดาวน์โหลดไฟล์ที่อัปโหลด",
};
export function auditActionLabel(a: string | null | undefined): string {
  return lookup(AUDIT_ACTION, a);
}

// ---- point reason (point_reason enum, src/db/schema/enums.ts) ----
// Thai labels for the wallet history + detail. Falls back to raw code when unmapped.
const POINT_REASON: Record<string, string> = {
  checkin_in: "เช็คอินเข้างาน",
  checkin_out: "เช็คอินออกงาน",
  assessment_completed: "ทำแบบประเมิน",
  staff_grant_qr: "รับแต้มจากสตาฟ",
  manual_adjust: "ปรับแต้มโดยทีมงาน",
  peer_connect: "เพิ่มเพื่อน",
  correction_add: "ปรับแก้ (เพิ่ม)",
  correction_reverse: "ปรับแก้ (ถอนรายการ)",
};
export function pointReasonLabel(r: string | null | undefined): string {
  return lookup(POINT_REASON, r);
}

// ---- point/connect/claim/assessment result codes (returned in response bodies; UI branches on these) ----
// One map across the earning flows — each code maps to a short Thai message for toasts/result panels.
const POINT_RESULT: Record<string, string> = {
  // grant claim
  granted_success: "รับแต้มสำเร็จ",
  already_claimed: "รับแต้มนี้ไปแล้ว",
  grant_exhausted: "โควตาแต้มเต็มแล้ว",
  grant_expired: "QR หมดอายุแล้ว",
  grant_revoked: "QR ถูกยกเลิกแล้ว",
  grant_invalid: "QR ไม่ถูกต้อง",
  // peer connect
  connected_success: "เพิ่มเพื่อนสำเร็จ",
  already_connected: "เพิ่มเพื่อนคนนี้ไปแล้ว",
  cannot_connect_self: "สแกน QR ตัวเองไม่ได้",
  connect_cooldown: "รอสักครู่ก่อนสแกนคนต่อไป",
  connect_invalid: "QR ไม่ถูกต้อง",
  peer_disabled: "ปิดการเพิ่มเพื่อนชั่วคราว",
  not_student: "เฉพาะนักศึกษาเท่านั้นที่ได้รับแต้ม",
  // assessment submit
  submitted_success: "ส่งแบบประเมินสำเร็จ",
  already_submitted: "ทำแบบประเมินนี้ไปแล้ว",
  assessment_not_open: "ยังไม่เปิดให้ทำแบบประเมิน",
  assessment_closed: "ปิดรับแบบประเมินแล้ว",
  no_assessment_form: "ยังไม่มีแบบประเมินสำหรับงานนี้",
  checkin_required: "ต้องเช็คอินงานนี้ก่อนทำแบบประเมิน",
  // shared
  points_closed: "ปิดการเก็บแต้มแล้ว (ตัดยอดแล้ว)",
  network_error: "การเชื่อมต่อมีปัญหา ลองใหม่อีกครั้ง",
};
export function pointResultLabel(code: string | null | undefined): string {
  return lookup(POINT_RESULT, code);
}

// ---- staff budget reason (staff_budget_reason enum, src/db/schema/enums.ts) ----
// Thai labels for the staff-budget ledger (admin budget detail page).
const BUDGET_REASON: Record<string, string> = {
  topup: "เติมงบ",
  grant_issue: "สร้าง QR แต้ม (หักงบ)",
  grant_refund: "คืนงบ (สิทธิ์เหลือ)",
  manual_grant: "แจกมือให้นักศึกษา (หักงบ)",
  admin_adjust: "ปรับงบโดยผู้ดูแล",
};
export function budgetReasonLabel(r: string | null | undefined): string {
  return lookup(BUDGET_REASON, r);
}

// ---- audit entity types (entityType literals across src/modules) ----
const AUDIT_ENTITY: Record<string, string> = {
  auth: "การยืนยันตัวตน",
  user: "ผู้ใช้",
  user_import: "การนำเข้าผู้ใช้",
  event: "กิจกรรม",
  event_form_version: "ฟอร์มกิจกรรม",
  registration: "การลงทะเบียน",
  uploaded_file: "ไฟล์ที่อัปโหลด",
};
export function auditEntityLabel(e: string | null | undefined): string {
  return lookup(AUDIT_ENTITY, e);
}
