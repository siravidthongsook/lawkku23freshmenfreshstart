import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { sessions } from "../src/db/schema/sessions";
import type { User } from "../src/db/schema/users";
import { loginAs } from "./helpers/auth";

// ---------------------------------------------------------------------------
// Role-based session TTL (src/lib/session.ts:10-19). createSession() stamps
// expires_at = created_at-ish + TTL_MS[role]:
//   student 30d, checkin_staff 12h, admin 8h.
// We log in for each role, read the freshly-created sessions row, and assert
// expiresAt - createdAt ≈ the role's TTL. Tolerance covers the small gap
// between defaultNow() (DB clock) and Date.now() (app clock) at insert time.
// ---------------------------------------------------------------------------

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const EXPECTED_TTL_MS: Record<User["role"], number> = {
  student: 30 * DAY,
  checkin_staff: 12 * HOUR,
  admin: 8 * HOUR,
};

const TOLERANCE_MS = 5000; // app/db clock skew + insert latency

// Grab the single session created for a freshly-logged-in user.
async function sessionForUser(userId: string) {
  const [row] = await db.select().from(sessions).where(eq(sessions.userId, userId)).limit(1);
  return row;
}

describe("sessions: role-based TTL", () => {
  for (const role of ["student", "checkin_staff", "admin"] as const) {
    it(`${role} session lifetime ≈ ${EXPECTED_TTL_MS[role] / HOUR}h`, async () => {
      const { user } = await loginAs(role);
      const row = await sessionForUser(user.id);
      expect(row).toBeTruthy();

      // roleSnapshot is captured at creation → drives the TTL semantics.
      expect(row!.roleSnapshot).toBe(role);

      const lifetime = row!.expiresAt.getTime() - row!.createdAt.getTime();
      expect(Math.abs(lifetime - EXPECTED_TTL_MS[role])).toBeLessThanOrEqual(TOLERANCE_MS);
    });
  }

  it("student TTL is far longer than staff/admin (relative ordering holds)", async () => {
    const student = await loginAs("student");
    const staff = await loginAs("checkin_staff");
    const admin = await loginAs("admin");

    const sRow = await sessionForUser(student.user.id);
    const stRow = await sessionForUser(staff.user.id);
    const aRow = await sessionForUser(admin.user.id);

    const life = (r: typeof sRow) => r!.expiresAt.getTime() - r!.createdAt.getTime();
    expect(life(sRow)).toBeGreaterThan(life(stRow));
    expect(life(stRow)).toBeGreaterThan(life(aRow)); // 12h staff > 8h admin
  });
});
