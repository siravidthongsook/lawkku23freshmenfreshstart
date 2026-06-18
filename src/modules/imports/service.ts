import Papa from "papaparse";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/client";
import { users } from "../../db/schema/users";
import { registrations } from "../../db/schema/registrations";
import { events } from "../../db/schema/events";
import type { ImportRow, RowStatus } from "./schema";

// Header aliases — accept a few common column spellings (case/space-insensitive).
const HEADER_MAP: Record<string, string> = {
  email: "email",
  "e-mail": "email",
  studentid: "studentId",
  "student id": "studentId",
  "student_id": "studentId",
  fullname: "fullName",
  "full name": "fullName",
  "full_name": "fullName",
  name: "fullName",
  faculty: "faculty",
  department: "department",
  dept: "department",
  phone: "phone",
};

const normHeader = (h: string) => HEADER_MAP[h.trim().toLowerCase()] ?? h.trim().toLowerCase();
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type RawRow = Record<string, string>;

// Parse CSV text into normalized raw rows keyed by canonical field names.
export function parseCsv(text: string): RawRow[] {
  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: normHeader,
  });
  return parsed.data.map((r) => {
    const out: RawRow = {};
    for (const [k, v] of Object.entries(r)) out[k] = (v ?? "").toString().trim();
    return out;
  });
}

// Compute per-row status against current DB state (existence + in-file duplicates + capacity).
export async function buildPreviewRows(
  raw: RawRow[],
  opts: { registerToEvent: boolean; targetEventId: string | null },
): Promise<ImportRow[]> {
  const rows: ImportRow[] = [];
  const seenEmail = new Set<string>();
  const seenStudentId = new Set<string>();

  const emails = raw.map((r) => (r.email ?? "").toLowerCase()).filter(Boolean);
  const studentIds = raw.map((r) => r.studentId ?? "").filter(Boolean);

  // Existing users lookup — used to decide create vs update.
  const existingByEmail = new Map<string, { id: string; studentId: string | null }>();
  // email is nullable now (imported users have none); these maps only hold rows that actually have one.
  const existingByStudentId = new Map<string, { id: string; email: string | null }>();
  if (emails.length) {
    const found = await db
      .select({ id: users.id, email: users.email, studentId: users.studentId })
      .from(users)
      .where(inArray(users.email, emails));
    for (const u of found) if (u.email) existingByEmail.set(u.email.toLowerCase(), { id: u.id, studentId: u.studentId });
  }
  if (studentIds.length) {
    const found = await db
      .select({ id: users.id, email: users.email, studentId: users.studentId })
      .from(users)
      .where(inArray(users.studentId, studentIds));
    for (const u of found) if (u.studentId) existingByStudentId.set(u.studentId, { id: u.id, email: u.email });
  }

  // Capacity context (only relevant when registering to an event).
  let remainingCapacity: number | null = null; // null = unlimited
  if (opts.registerToEvent && opts.targetEventId) {
    const [ev] = await db
      .select({ capacityEnabled: events.capacityEnabled, capacityLimit: events.capacityLimit })
      .from(events)
      .where(eq(events.id, opts.targetEventId))
      .limit(1);
    if (ev?.capacityEnabled && ev.capacityLimit != null) {
      const countRows = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(registrations)
        .where(
          and(
            eq(registrations.eventId, opts.targetEventId),
            inArray(registrations.status, ["registered", "checked_in"]),
          ),
        );
      remainingCapacity = ev.capacityLimit - Number(countRows[0]?.count ?? 0);
    }
  }

  let i = 0;
  for (const r of raw) {
    i++;
    const email = (r.email ?? "").toLowerCase();
    const studentId = r.studentId || null;
    const fullName = r.fullName || "";

    let status: RowStatus;
    let note: string | undefined;

    if (!email || !emailRe.test(email) || !fullName) {
      status = "invalid";
      note = !email ? "missing email" : !emailRe.test(email) ? "invalid email" : "missing full name";
    } else if (seenEmail.has(email)) {
      status = "duplicate_email";
      note = "email repeated in file";
    } else if (studentId && seenStudentId.has(studentId)) {
      status = "duplicate_student_id";
      note = "student_id repeated in file";
    } else {
      // Cross-row uniqueness: a student_id already used by a DIFFERENT existing user is a conflict.
      const byStudentId = studentId ? existingByStudentId.get(studentId) : undefined;
      const byEmail = existingByEmail.get(email);
      if (studentId && byStudentId && (!byEmail || byEmail.id !== byStudentId.id)) {
        status = "duplicate_student_id";
        note = "student_id belongs to another user";
      } else if (byEmail) {
        status = "will_update";
        // Over-capacity registration is flagged even for updates that get registered.
        if (opts.registerToEvent && remainingCapacity !== null) {
          if (remainingCapacity <= 0) status = "will_register_over_capacity";
          else remainingCapacity--;
        }
      } else {
        status = "will_create";
        if (opts.registerToEvent && remainingCapacity !== null) {
          if (remainingCapacity <= 0) status = "will_register_over_capacity";
          else remainingCapacity--;
        }
      }
    }

    if (email) seenEmail.add(email);
    if (studentId) seenStudentId.add(studentId);

    rows.push({
      rowNumber: i,
      email,
      studentId,
      fullName,
      faculty: r.faculty || null,
      department: r.department || null,
      phone: r.phone || null,
      status,
      note,
    });
  }

  return rows;
}

export function tallyCounts(rows: ImportRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
  counts.total = rows.length;
  return counts;
}
