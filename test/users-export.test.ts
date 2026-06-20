import { describe, it, expect } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
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

  // Activation = self-set permanent password: password_hash set AND password_must_change=false.
  // Two provisioning flows feed "not activated": unclaimed students (hash NULL) AND staff still on a
  // temp pw (hash SET but must_change=true). The latter is the case the old hash-only rule got wrong.
  it("claimed filter uses the activation predicate (hash set AND not must_change)", async () => {
    const admin = await loginAs("admin");
    // student claimed: self-set permanent password.
    await makeUser({ studentId: "exp-stu-claimed", passwordHash: "x", passwordMustChange: false });
    // student unclaimed: no password yet.
    await makeUser({ studentId: "exp-stu-unclaimed", passwordHash: null, passwordMustChange: false });
    // staff on temp pw: hash SET but still forced to change -> NOT activated (old rule got this wrong).
    const staffTemp = await makeUser({
      studentId: "exp-staff-temp",
      role: "checkin_staff",
      passwordHash: "x",
      passwordMustChange: true,
    });
    await addPendingTempPw(staffTemp.id, admin.user.id);
    // staff activated: changed their temp pw to a permanent one.
    await makeUser({
      studentId: "exp-staff-active",
      role: "checkin_staff",
      passwordHash: "x",
      passwordMustChange: false,
    });

    // claimed=yes -> only the two fully-activated users.
    const yes = studentIds(await (await request("/admin/users/export?claimed=yes", { cookie: admin.cookie })).text());
    expect(yes).toContain("exp-stu-claimed");
    expect(yes).toContain("exp-staff-active");
    expect(yes).not.toContain("exp-stu-unclaimed");
    expect(yes).not.toContain("exp-staff-temp");

    // claimed=no -> unclaimed student AND the temp-pw staff (both not-yet-activated).
    const no = studentIds(await (await request("/admin/users/export?claimed=no", { cookie: admin.cookie })).text());
    expect(no).toContain("exp-stu-unclaimed");
    expect(no).toContain("exp-staff-temp");
    expect(no).not.toContain("exp-stu-claimed");
    expect(no).not.toContain("exp-staff-active");
  });

  // The CSV `claimed` column value must match the activation predicate for every shape.
  it("claimed column value reflects activation (yes only when hash set AND not must_change)", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-col-stu-claimed", passwordHash: "x", passwordMustChange: false });
    await makeUser({ studentId: "exp-col-stu-unclaimed", passwordHash: null, passwordMustChange: false });
    const staffTemp = await makeUser({
      studentId: "exp-col-staff-temp",
      role: "checkin_staff",
      passwordHash: "x",
      passwordMustChange: true,
    });
    await addPendingTempPw(staffTemp.id, admin.user.id);
    await makeUser({
      studentId: "exp-col-staff-active",
      role: "checkin_staff",
      passwordHash: "x",
      passwordMustChange: false,
    });

    const { rows } = parseCsv(await (await request("/admin/users/export", { cookie: admin.cookie })).text());
    const byId = (sid: string) => rows.find((r) => r.student_id === sid)!;
    expect(byId("exp-col-stu-claimed").claimed).toBe("yes");
    expect(byId("exp-col-stu-unclaimed").claimed).toBe("no");
    expect(byId("exp-col-staff-temp").claimed).toBe("no"); // hash set but still on temp pw
    expect(byId("exp-col-staff-active").claimed).toBe("yes");
  });

  // pending_temp_pw is a COLUMN only — the filter was merged into claimed=no (strict subset).
  it("pending_temp_pw column reflects whether a pending temp pw exists (yes/no per row)", async () => {
    const admin = await loginAs("admin");
    const withPw = await makeUser({ studentId: "exp-pending" });
    await makeUser({ studentId: "exp-nopending" });
    await addPendingTempPw(withPw.id, admin.user.id);

    const { rows } = parseCsv(await (await request("/admin/users/export", { cookie: admin.cookie })).text());
    expect(rows.find((r) => r.student_id === "exp-pending")!.pending_temp_pw).toBe("yes");
    expect(rows.find((r) => r.student_id === "exp-nopending")!.pending_temp_pw).toBe("no");
  });

  // temp_password column = DECRYPTED plaintext (opt-in column folded in from the retired bulk export).
  it("temp_password column contains decrypted plaintext for pending users, empty otherwise", async () => {
    const admin = await loginAs("admin");
    const withPw = await makeUser({ studentId: "exp-tp-yes" });
    await makeUser({ studentId: "exp-tp-no" });
    await addPendingTempPw(withPw.id, admin.user.id); // encrypts "temp-secret-123"

    const { rows } = parseCsv(
      await (
        // reason required now that temp_password (plaintext) is requested
        await request("/admin/users/export?columns=student_id,temp_password&reason=test", { cookie: admin.cookie })
      ).text(),
    );
    expect(rows.find((r) => r.student_id === "exp-tp-yes")!.temp_password).toBe("temp-secret-123");
    expect(rows.find((r) => r.student_id === "exp-tp-no")!.temp_password).toBe("");
  });

  // Even when temp_password IS exported, the audit row must carry NO plaintext password value.
  it("audit row for a temp_password export contains no plaintext password", async () => {
    const admin = await loginAs("admin");
    const withPw = await makeUser({ studentId: "exp-tp-audit" });
    await addPendingTempPw(withPw.id, admin.user.id); // encrypts "temp-secret-123"

    // reason required now that temp_password (plaintext) is requested
    await request("/admin/users/export?columns=student_id,temp_password&reason=test", { cookie: admin.cookie });

    const audits = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "users_exported"), eq(auditLogs.actorUserId, admin.user.id)));
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) {
      // The known plaintext must never appear anywhere in the audit metadata.
      expect(JSON.stringify(a.metadata)).not.toContain("temp-secret-123");
    }
  });

  // Plaintext temp_password export requires a reason — guard fires before any audit row is written.
  it("temp_password requested WITHOUT reason -> 400 reason_required and writes NO audit row", async () => {
    const admin = await loginAs("admin");
    const withPw = await makeUser({ studentId: "exp-noreason" });
    await addPendingTempPw(withPw.id, admin.user.id);

    const before = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "users_exported"), eq(auditLogs.actorUserId, admin.user.id)));

    const res = await request("/admin/users/export?columns=student_id,temp_password", {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("reason_required");

    // No audit row should have been written for this rejected attempt.
    const after = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "users_exported"), eq(auditLogs.actorUserId, admin.user.id)));
    expect(after.length).toBe(before.length);
  });

  // With a reason: 200, audit flags included_temp_password + stores reason, still no plaintext anywhere.
  it("temp_password + reason -> 200; audit has included_temp_password + reason, no plaintext", async () => {
    const admin = await loginAs("admin");
    const withPw = await makeUser({ studentId: "exp-reason-ok" });
    await addPendingTempPw(withPw.id, admin.user.id); // encrypts "temp-secret-123"

    const reason = "ส่งให้ฝ่ายทะเบียนแจกนักศึกษา";
    const res = await request(
      `/admin/users/export?columns=student_id,temp_password&reason=${encodeURIComponent(reason)}`,
      { cookie: admin.cookie },
    );
    expect(res.status).toBe(200);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "users_exported"), eq(auditLogs.actorUserId, admin.user.id)));
    expect(audit).toBeDefined();
    const md = audit!.metadata as { included_temp_password: boolean };
    expect(md.included_temp_password).toBe(true);
    expect(audit!.reason).toBe(reason);
    // The plaintext secret must never appear in the audit row (metadata, reason, or anywhere).
    expect(JSON.stringify(audit)).not.toContain("temp-secret-123");
  });

  // Export without the secret column needs no reason and flags included_temp_password=false.
  it("export WITHOUT temp_password (no reason) -> 200; audit included_temp_password=false", async () => {
    const admin = await loginAs("admin");
    await makeUser({ studentId: "exp-no-tp-flag" });

    const res = await request("/admin/users/export?columns=student_id,full_name", {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(200);

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "users_exported"), eq(auditLogs.actorUserId, admin.user.id)));
    expect(audit).toBeDefined();
    const md = audit!.metadata as { included_temp_password: boolean };
    expect(md.included_temp_password).toBe(false);
    expect(audit!.reason).toBeNull();
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

  // PDPA accountability: the audit must record WHICH user_ids were disclosed — UUIDs only, no PII.
  // Cap test (10k) is intentionally skipped: seeding 10k users is wasteful; the slice/flag logic is trivial.
  it("audit records exported_user_ids = the disclosed UUIDs (UUID only, no email/student_id), not truncated", async () => {
    const admin = await loginAs("admin");
    const u1 = await makeUser({ studentId: "exp-uid-1", email: "uid1@example.test", role: "student" });
    const u2 = await makeUser({ studentId: "exp-uid-2", email: "uid2@example.test", role: "student" });

    await request("/admin/users/export?role=student&status=active", { cookie: admin.cookie });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "users_exported"), eq(auditLogs.actorUserId, admin.user.id)));
    expect(audit).toBeDefined();
    const md = audit!.metadata as { exported_user_ids: string[]; user_ids_truncated: boolean };

    // The two seeded users' UUIDs must be present (order-insensitive set membership).
    const idSet = new Set(md.exported_user_ids);
    expect(idSet.has(u1.id)).toBe(true);
    expect(idSet.has(u2.id)).toBe(true);
    expect(md.user_ids_truncated).toBe(false);

    // Every recorded id must be a real users.id UUID.
    expect(md.exported_user_ids.length).toBeGreaterThan(0);
    const real = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.id, md.exported_user_ids));
    expect(real.length).toBe(md.exported_user_ids.length);

    // UUID list ONLY — no email/student_id (or any other identity) leaked into the audit metadata.
    const mdJson = JSON.stringify(audit!.metadata);
    expect(mdJson).not.toContain("uid1@example.test");
    expect(mdJson).not.toContain("uid2@example.test");
    expect(mdJson).not.toContain("exp-uid-1");
    expect(mdJson).not.toContain("exp-uid-2");
  });
});
