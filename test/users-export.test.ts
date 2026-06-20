import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { temporaryPasswords, users } from "../src/db/schema/users";
import { auditLogs } from "../src/db/schema/audit";
import { encryptSecret } from "../src/lib/crypto";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";

// Admin "Export Users" CSV (plan /tmp/users-export-plan.md). Export shares buildUserFilters with the
// LIST endpoint so the CSV always matches what the admin sees. Secrets are NEVER exportable.

// Parse a CSV string into header + row objects (papaparse output is \r\n delimited).
function parseCsv(csv: string): { header: string[]; rows: Record<string, string>[] } {
  const lines = csv.trim().split("\r\n");
  const header = lines[0]!.split(",");
  const rows = lines.slice(1).map((line) => {
    // Naive split is fine — our test data has no commas/quotes in cell values.
    const cells = line.split(",");
    const o: Record<string, string> = {};
    header.forEach((h, i) => (o[h] = cells[i] ?? ""));
    return o;
  });
  return { header, rows };
}

// Pull every student_id column from a parsed export (the stable identity we assert on).
function studentIds(csv: string): string[] {
  const { rows } = parseCsv(csv);
  return rows.map((r) => r.student_id!).filter(Boolean);
}

// Insert a user row directly so tests control createdAt / lastActiveAt / instagram precisely.
let n = 0;
async function makeUser(over: Partial<typeof users.$inferInsert> = {}) {
  n++;
  const [row] = await db
    .insert(users)
    .values({
      role: "student",
      fullName: `Export U${n}`,
      studentId: `exp-${n}`,
      passwordHash: "x", // claimed by default; null to simulate unclaimed
      ...over,
    })
    .returning();
  return row!;
}

async function addPendingTempPw(userId: string, adminId: string) {
  await db.insert(temporaryPasswords).values({
    userId,
    encryptedTempPassword: encryptSecret("temp-secret-123"),
    createdByAdminId: adminId,
  });
}

// Fetch the LIST student_ids for a given query string, to assert export == list.
async function listStudentIds(cookie: string, qs: string): Promise<string[]> {
  const res = await request(`/admin/users?limit=200${qs}`, { cookie });
  const body = (await res.json()) as { users: { student_id: string | null }[] };
  return body.users.map((u) => u.student_id).filter((s): s is string => Boolean(s));
}

describe("users export: GET /admin/users/export", () => {
  it("rejects non-admin (staff) with 403", async () => {
    const staff = await loginAs("checkin_staff");
    const res = await request("/admin/users/export", { cookie: staff.cookie });
    expect(res.status).toBe(403);
  });

  it("exports all matching users with the full allow-listed column set + Bangkok timestamps", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-a", instagram: "iggy" });

    const res = await request("/admin/users/export", { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("users-export-");
    expect(res.headers.get("content-disposition")).toContain(".csv");

    const csv = await res.text();
    const { header } = parseCsv(csv);
    for (const col of [
      "student_id",
      "full_name",
      "email",
      "username",
      "role",
      "status",
      "group_number",
      "faculty",
      "department",
      "phone",
      "instagram",
      "claimed",
      "pending_temp_pw",
      "created_at_bangkok",
      "last_active_at_bangkok",
    ]) {
      expect(header).toContain(col);
    }
    expect(csv).toContain("+07:00"); // BKK-labeled created_at
  });

  it("NEVER includes secret columns (password_hash / temp_password / token)", async () => {
    const admin = await loginAs("admin");
    const u = await makeUser({ studentId: "exp-secret" });
    await addPendingTempPw(u.id, admin.user.id);

    const res = await request("/admin/users/export?columns=student_id,pending_temp_pw", {
      cookie: admin.cookie,
    });
    const csv = await res.text();
    const { header } = parseCsv(csv);
    expect(header).not.toContain("password_hash");
    expect(header).not.toContain("temp_password");
    expect(header).not.toContain("temporary_password");
    expect(header).not.toContain("session_token");
    expect(header).not.toContain("encrypted_temp_password");
    // And the argon2 hash value must not leak into the body.
    expect(csv).not.toContain("$argon2");
    expect(csv).not.toContain("temp-secret-123");
  });

  it("columns param outputs only the requested allow-listed subset; unknown keys ignored", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-cols" });

    const res = await request(
      "/admin/users/export?columns=student_id,full_name,bogus_col,password_hash",
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(200);
    const { header } = parseCsv(await res.text());
    expect(header).toEqual(["student_id", "full_name"]);
  });

  it("role filter narrows results", async () => {
    const admin = await loginAs("admin");
    await makeUser({ role: "student", studentId: "exp-stu" });
    await seedUser({ role: "checkin_staff" });

    const res = await request("/admin/users/export?role=student", { cookie: admin.cookie });
    const ids = studentIds(await res.text());
    expect(ids).toContain("exp-stu");
    // Every exported row is a student → no staff/admin rows present.
    const { rows } = parseCsv(await (await request("/admin/users/export?role=student", { cookie: admin.cookie })).text());
    expect(rows.every((r) => r.role === "student")).toBe(true);
  });

  it("status filter narrows results", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-active", status: "active" });
    await makeUser({ studentId: "exp-disabled", status: "disabled" });

    const csv = await (await request("/admin/users/export?status=disabled", { cookie: admin.cookie })).text();
    const ids = studentIds(csv);
    expect(ids).toContain("exp-disabled");
    expect(ids).not.toContain("exp-active");
  });

  it("claimed filter narrows (yes = password set, no = unclaimed)", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-claimed", passwordHash: "x" });
    await makeUser({ studentId: "exp-unclaimed", passwordHash: null });

    const yes = studentIds(await (await request("/admin/users/export?claimed=yes", { cookie: admin.cookie })).text());
    expect(yes).toContain("exp-claimed");
    expect(yes).not.toContain("exp-unclaimed");

    const no = studentIds(await (await request("/admin/users/export?claimed=no", { cookie: admin.cookie })).text());
    expect(no).toContain("exp-unclaimed");
    expect(no).not.toContain("exp-claimed");
  });

  it("pending_temp_pw filter narrows (EXISTS / NOT EXISTS on temporary_passwords)", async () => {
    const admin = await loginAs("admin");
    const withPw = await makeUser({ studentId: "exp-pending" });
    await makeUser({ studentId: "exp-nopending" });
    await addPendingTempPw(withPw.id, admin.user.id);

    const yes = studentIds(await (await request("/admin/users/export?pending_temp_pw=yes", { cookie: admin.cookie })).text());
    expect(yes).toContain("exp-pending");
    expect(yes).not.toContain("exp-nopending");

    const no = studentIds(await (await request("/admin/users/export?pending_temp_pw=no", { cookie: admin.cookie })).text());
    expect(no).toContain("exp-nopending");
    expect(no).not.toContain("exp-pending");

    // pending_temp_pw column reflects the flag.
    const { rows } = parseCsv(await (await request("/admin/users/export?pending_temp_pw=yes", { cookie: admin.cookie })).text());
    expect(rows.find((r) => r.student_id === "exp-pending")!.pending_temp_pw).toBe("yes");
  });

  it("group_number filter narrows", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-g3", groupNumber: 3 });
    await makeUser({ studentId: "exp-g7", groupNumber: 7 });

    const ids = studentIds(await (await request("/admin/users/export?group_number=3", { cookie: admin.cookie })).text());
    expect(ids).toContain("exp-g3");
    expect(ids).not.toContain("exp-g7");
  });

  it("created_from / created_to filter narrows on BKK calendar dates (inclusive end of day)", async () => {
    const admin = await loginAs("admin");
    // 2026-01-10 12:00 UTC = 2026-01-10 19:00 BKK → inside the 2026-01-10 BKK day.
    await makeUser({ studentId: "exp-jan10", createdAt: new Date("2026-01-10T12:00:00Z") });
    // 2026-01-09 18:00 UTC = 2026-01-10 01:00 BKK → still the 2026-01-10 BKK day (offset proof).
    await makeUser({ studentId: "exp-jan10b", createdAt: new Date("2026-01-09T18:00:00Z") });
    await makeUser({ studentId: "exp-jan20", createdAt: new Date("2026-01-20T12:00:00Z") });

    const csv = await (
      await request("/admin/users/export?created_from=2026-01-10&created_to=2026-01-10", { cookie: admin.cookie })
    ).text();
    const ids = studentIds(csv);
    expect(ids).toContain("exp-jan10");
    expect(ids).toContain("exp-jan10b");
    expect(ids).not.toContain("exp-jan20");
  });

  it("never_active filter narrows (lastActiveAt NULL)", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-never", lastActiveAt: null });
    await makeUser({ studentId: "exp-seen", lastActiveAt: new Date("2026-02-01T00:00:00Z") });

    const ids = studentIds(await (await request("/admin/users/export?never_active=true", { cookie: admin.cookie })).text());
    expect(ids).toContain("exp-never");
    expect(ids).not.toContain("exp-seen");
  });

  it("INVARIANT: export rows == list rows for identical filters", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-inv1", role: "student", status: "active" });
    await makeUser({ studentId: "exp-inv2", role: "student", status: "active" });
    await makeUser({ studentId: "exp-inv3", role: "student", status: "disabled" });
    await seedUser({ role: "checkin_staff" });

    const qs = "&role=student&status=active";
    const exportIds = studentIds(
      await (await request(`/admin/users/export?role=student&status=active`, { cookie: admin.cookie })).text(),
    );
    const listIds = await listStudentIds(admin.cookie, qs);
    expect(new Set(exportIds)).toEqual(new Set(listIds));
  });

  it("writes an append-only audit row with row count + filter summary, no PII", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-audit", role: "student" });

    await request("/admin/users/export?role=student", { cookie: admin.cookie });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "users_exported"), eq(auditLogs.actorUserId, admin.user.id)));
    expect(audit).toBeDefined();
    const md = audit!.metadata as { row_count: number; truncated: boolean; filters: Record<string, unknown> };
    expect(typeof md.row_count).toBe("number");
    expect(md.truncated).toBe(false);
    expect(md.filters.role).toBe("student");
    // No row content / identity leaked into the audit metadata.
    expect(JSON.stringify(audit!.metadata)).not.toContain("exp-audit");
    expect(JSON.stringify(audit!.metadata)).not.toContain("$argon2");
  });
});
