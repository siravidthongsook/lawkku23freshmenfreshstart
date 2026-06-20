// QA browser-test seed: fresh admin/staff/2 students with known passwords. Idempotent by email.
// Run: pnpm tsx --env-file-if-exists=.env scripts/seed-qa.ts   (DELETE this file after QA)
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { hashPassword } from "../src/lib/password";

const PW = "QaTest1234!"; // 11 chars, passes 10–128 policy

const ACCOUNTS = [
  { email: "qa-admin@test.local", role: "admin" as const, fullName: "QA Admin", username: null, studentId: null, nickname: null, groupNumber: null, instagram: null },
  { email: "qa-staff@test.local", role: "checkin_staff" as const, fullName: "QA Staff", username: "qa-staff-01", studentId: null, nickname: null, groupNumber: null, instagram: null },
  { email: "qa-stud1@test.local", role: "student" as const, fullName: "QA Student One", username: null, studentId: "QA0001", nickname: "วันคิว", groupNumber: 1, instagram: "qa_stud1" },
  { email: "qa-stud2@test.local", role: "student" as const, fullName: "QA Student Two", username: null, studentId: "QA0002", nickname: "ทูคิว", groupNumber: 1, instagram: "qa_stud2" },
];

async function main() {
  const passwordHash = await hashPassword(PW);
  for (const a of ACCOUNTS) {
    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.email, a.email)).limit(1);
    if (existing) {
      console.log(`[seed-qa] skip (exists): ${a.email}`);
      continue;
    }
    await db.insert(users).values({
      email: a.email,
      role: a.role,
      fullName: a.fullName,
      username: a.username,
      studentId: a.studentId,
      nickname: a.nickname,
      groupNumber: a.groupNumber,
      instagram: a.instagram,
      passwordHash,
      passwordMustChange: false, // skip the change-password wall for QA
      status: "active",
      createdByAdminId: null,
    });
    console.log(`[seed-qa] created ${a.role}: ${a.email}` + (a.username ? ` (username ${a.username})` : a.studentId ? ` (student_id ${a.studentId})` : ""));
  }
  console.log(`\n[seed-qa] password for all QA accounts: ${PW}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
