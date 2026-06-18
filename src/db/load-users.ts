import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db, pool } from "./client";
import { users, type NewUser } from "./schema/users";

// Import-only user loader. Creates students (from freshmen.json) + staff (from mentors.json).
// Email-less, password-less accounts: NULL password_hash = not yet claimed (see /tmp claim plan §2/§4.2).
// Idempotent: upsert by student_id (students) / username (staff). Never touches a claimed user's password_hash.

// Default source paths; override via argv[2] (freshmen) and argv[3] (mentors).
const FRESHMEN_PATH =
  process.argv[2] ?? "/Users/siravid/Downloads/useraccountdataforfreshmanlawevents/freshmen.json";
const MENTORS_PATH =
  process.argv[3] ?? "/Users/siravid/Downloads/useraccountdataforfreshmanlawevents/mentors.json";

type Freshman = {
  order: number;
  student_id: string;
  title: string;
  first_name: string;
  last_name: string;
  full_name: string;
  group: number;
};

type Mentor = {
  idx: number;
  category: string;
  first_name: string;
  last_name: string;
  full_name: string;
  nickname: string;
  year: number;
  role: string;
  group: number;
};

// Read + parse a JSON array; fail loud with the exact path if missing/unreadable.
function readJsonArray<T>(path: string, label: string): T[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`[load-users] cannot read ${label} file at ${path}: ${(err as Error).message}`);
  }
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`[load-users] ${label} file ${path} is not a JSON array`);
  return parsed as T[];
}

// Map a freshman record to a student user row. studentId is the upsert key; no email/password.
function freshmanToUser(f: Freshman): NewUser {
  return {
    role: "student",
    studentId: f.student_id,
    fullName: f.full_name,
    title: f.title,
    groupNumber: f.group,
    passwordHash: null, // unclaimed
    email: null, // students have no email
    passwordMustChange: false,
  };
}

// Map a mentor record to a checkin_staff user row. username (staff-NN) is the upsert key.
function mentorToUser(m: Mentor): NewUser {
  return {
    role: "checkin_staff",
    username: `staff-${String(m.idx).padStart(2, "0")}`,
    fullName: m.full_name,
    nickname: m.nickname,
    year: m.year,
    mentorRole: m.role, // raw Thai role text
    category: m.category, // raw category; role is always checkin_staff
    groupNumber: m.group,
    passwordHash: null, // unclaimed
    email: null, // mentors have no email
    passwordMustChange: false,
  };
}

// Upsert all rows on a given conflict target, updating ONLY profile fields.
// CRITICAL: password_hash is intentionally absent from the update set, so a claimed
// user (non-null hash) is never clobbered or reset to null on re-run.
async function upsertOnConflict(
  rows: NewUser[],
  conflictColumn: typeof users.studentId | typeof users.username,
): Promise<{ created: number; updated: number }> {
  let created = 0;
  let updated = 0;
  for (const row of rows) {
    // xmax = 0 on an inserted tuple, non-zero when an existing row was updated → distinguishes the two.
    const result = await db
      .insert(users)
      .values(row)
      .onConflictDoUpdate({
        target: conflictColumn,
        set: {
          fullName: row.fullName,
          title: row.title ?? null,
          nickname: row.nickname ?? null,
          year: row.year ?? null,
          mentorRole: row.mentorRole ?? null,
          category: row.category ?? null,
          groupNumber: row.groupNumber ?? null,
          role: row.role,
          updatedAt: new Date(),
          // password_hash deliberately NOT in set — never clobber a claimed account.
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    if (result[0]?.inserted) created += 1;
    else updated += 1;
  }
  return { created, updated };
}

async function load(): Promise<void> {
  const freshmen = readJsonArray<Freshman>(FRESHMEN_PATH, "freshmen");
  const mentors = readJsonArray<Mentor>(MENTORS_PATH, "mentors");
  console.log(`[load-users] read ${freshmen.length} freshmen, ${mentors.length} mentors`);

  const studentRows = freshmen.map(freshmanToUser);
  const staffRows = mentors.map(mentorToUser);

  const students = await upsertOnConflict(studentRows, users.studentId);
  const staff = await upsertOnConflict(staffRows, users.username);

  console.log(`[load-users] students: ${students.created} created, ${students.updated} updated`);
  console.log(`[load-users] staff:    ${staff.created} created, ${staff.updated} updated`);
  console.log("[load-users] done.");
}

load()
  .then(() => pool.end())
  .catch((err) => {
    console.error("[load-users] failed:", err);
    return pool.end().finally(() => process.exit(1));
  });
