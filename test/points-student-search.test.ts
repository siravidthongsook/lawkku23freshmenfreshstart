import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";

// GET /points/student-search — staff/admin-only typeahead for the manual-give flow.
// Verifies: minimal fields only (no PII), active-students-only filter, role gate, q validation.

describe("points student-search: staff/admin pick a student for a manual grant", () => {
  it("staff can search and gets only active students with the minimal fields (no PII)", async () => {
    const staff = await loginAs("checkin_staff");
    // A matchable active student, with a nickname + group set so we can assert the shape.
    const student = await seedUser({ role: "student", fullName: "Searchable Somchai" });
    await db
      .update(users)
      .set({ nickname: "Chai", groupNumber: 7 })
      .where(eq(users.id, student.id));

    const res = await request("/points/student-search?q=Searchable", { cookie: staff.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { students: Record<string, unknown>[] };
    const hit = body.students.find((s) => s.id === student.id);
    expect(hit).toBeTruthy();
    // Exactly the minimal fields — and NOTHING else (no email/phone/balance leak).
    expect(Object.keys(hit!).sort()).toEqual(
      ["fullName", "groupNumber", "id", "nickname", "studentId"].sort(),
    );
    expect(hit).toMatchObject({ fullName: "Searchable Somchai", nickname: "Chai", groupNumber: 7 });
  });

  it("matches by nickname and by studentId (ILIKE)", async () => {
    const admin = await loginAs("admin");
    const student = await seedUser({ role: "student", fullName: "Niran Test", studentId: "zz-find-123" });
    await db.update(users).set({ nickname: "Ploy" }).where(eq(users.id, student.id));

    const byNick = await request("/points/student-search?q=Ploy", { cookie: admin.cookie });
    expect(((await byNick.json()) as { students: { id: string }[] }).students.some((s) => s.id === student.id)).toBe(true);

    const byId = await request("/points/student-search?q=zz-find", { cookie: admin.cookie });
    expect(((await byId.json()) as { students: { id: string }[] }).students.some((s) => s.id === student.id)).toBe(true);
  });

  it("excludes non-students and disabled students", async () => {
    const admin = await loginAs("admin");
    // Same distinctive token in all names so one query would catch any leak.
    const otherStaff = await seedUser({ role: "checkin_staff", fullName: "Excludeme Staff" });
    const disabled = await seedUser({ role: "student", fullName: "Excludeme Disabled", status: "disabled" });
    const active = await seedUser({ role: "student", fullName: "Excludeme Active" });

    const res = await request("/points/student-search?q=Excludeme", { cookie: admin.cookie });
    const ids = ((await res.json()) as { students: { id: string }[] }).students.map((s) => s.id);
    expect(ids).toContain(active.id);
    expect(ids).not.toContain(otherStaff.id); // non-student
    expect(ids).not.toContain(disabled.id); // disabled student
  });

  it("rejects too-short / empty q with 400", async () => {
    const staff = await loginAs("checkin_staff");
    expect((await request("/points/student-search?q=a", { cookie: staff.cookie })).status).toBe(400);
    expect((await request("/points/student-search", { cookie: staff.cookie })).status).toBe(400);
  });

  it("a student (non-staff/non-admin) is forbidden (403)", async () => {
    const student = await loginAs("student");
    const res = await request("/points/student-search?q=anything", { cookie: student.cookie });
    expect(res.status).toBe(403);
  });

  it("unauthenticated request is rejected (401)", async () => {
    const res = await request("/points/student-search?q=anything");
    expect(res.status).toBe(401);
  });
});
