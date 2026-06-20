import { describe, it, expect } from "vitest";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";

// Admin switch: hide the student-facing points/peer/leaderboard nav before the activity launches.
// The flag rides on /auth/me so the frontend nav can filter; earning is unaffected by it.

async function setVisible(adminCookie: string, visible: boolean) {
  return request("/admin/point-settings", {
    method: "PATCH",
    cookie: adminCookie,
    body: { student_points_visible: visible },
  });
}

async function meVisible(cookie: string): Promise<boolean> {
  const res = await request("/auth/me", { cookie });
  return ((await res.json()) as { student_points_visible: boolean }).student_points_visible;
}

describe("points visibility: admin toggle surfaced on /auth/me", () => {
  it("defaults to visible, and admin can hide then re-show for students", async () => {
    const admin = await loginAs("admin");
    const student = await loginAs("student");

    // Default (fresh settings row) → visible.
    expect(await meVisible(student.cookie)).toBe(true);

    // Admin hides it → student's /auth/me reflects false.
    const off = await setVisible(admin.cookie, false);
    expect(off.status).toBe(200);
    expect(await meVisible(student.cookie)).toBe(false);

    // Admin re-shows it → back to true.
    const on = await setVisible(admin.cookie, true);
    expect(on.status).toBe(200);
    expect(await meVisible(student.cookie)).toBe(true);
  });

  it("non-admin cannot change the visibility setting", async () => {
    const staff = await loginAs("checkin_staff");
    const res = await setVisible(staff.cookie, false);
    expect(res.status).toBe(403);
  });
});
