import { describe, it, expect } from "vitest";
import { eq, and } from "drizzle-orm";
import { db } from "../src/db/client";
import { pointLedger } from "../src/db/schema/points";
import { auditLogs } from "../src/db/schema/audit";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";

// Phase 7 points-ledger CSV export (plan §7). Admin-only audit/dispute trail of one student's full
// ledger. Reuses the formula-injection-safe csv-out; created_at column is Bangkok-labeled; the export
// itself is audited (append-only).

async function ledgerRow(userId: string, delta: number, reasonCode: "manual_adjust" | "correction_reverse", createdByUserId?: string) {
  await db.insert(pointLedger).values({ userId, delta, reasonCode, createdByUserId: createdByUserId ?? null });
}

describe("points export: GET /admin/users/:userId/points/export", () => {
  it("admin downloads a student's ledger as CSV with a Bangkok-labeled timestamp column", async () => {
    const admin = await loginAs("admin");
    const student = await seedUser({ role: "student" });
    await ledgerRow(student.id, 20, "manual_adjust", admin.user.id);
    await ledgerRow(student.id, -5, "correction_reverse", admin.user.id);

    const res = await request(`/admin/users/${student.id}/points/export`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain(".csv");
    expect(res.headers.get("x-row-count")).toBe("2");

    const csv = await res.text();
    const header = csv.split("\r\n")[0];
    expect(header).toContain("created_at_bangkok"); // Bangkok labeling per CLAUDE.md
    expect(header).toContain("delta");
    expect(header).toContain("reason_code");
    // +07:00 marker present on the data rows.
    expect(csv).toContain("+07:00");
    // Both ledger rows exported.
    expect(csv).toContain("20");
    expect(csv).toContain("-5");
  });

  it("writes an append-only audit entry (point_ledger_exported) recording who + row count", async () => {
    const admin = await loginAs("admin");
    const student = await seedUser({ role: "student" });
    await ledgerRow(student.id, 50, "manual_adjust", admin.user.id);

    await request(`/admin/users/${student.id}/points/export`, { cookie: admin.cookie });

    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.action, "point_ledger_exported"), eq(auditLogs.targetUserId, student.id)));
    expect(audit).toBeDefined();
    expect(audit!.actorUserId).toBe(admin.user.id);
    expect((audit!.metadata as { row_count: number }).row_count).toBe(1);
  });

  it("rejects non-admin (staff) with 403 — export is the admin correction audience only", async () => {
    const staff = await loginAs("checkin_staff");
    const student = await seedUser({ role: "student" });
    const res = await request(`/admin/users/${student.id}/points/export`, { cookie: staff.cookie });
    expect(res.status).toBe(403);
  });
});

// Audit-review (plan §9 phase 7 item 4 / §15.5): reverse/correct now log DISTINCT action codes so the
// audit trail is filterable by intent, not just by reasonCode buried in newValue.
describe("audit-review: reverse/correct write distinct audit action codes", () => {
  it("admin reverse → point_reverse; admin correct → point_correct (not generic point_award)", async () => {
    const admin = await loginAs("admin");
    const student = await seedUser({ role: "student" });
    // Seed one normal award to reverse (goes through addPoints → point_award).
    await request("/points/adjust", {
      method: "POST",
      cookie: admin.cookie,
      body: { user_id: student.id, delta: 30, reason: "give" },
    });
    const [orig] = await db
      .select()
      .from(pointLedger)
      .where(and(eq(pointLedger.userId, student.id), eq(pointLedger.reasonCode, "manual_adjust")));

    // Reverse it.
    const rev = await request(`/admin/users/${student.id}/points/reverse`, {
      method: "POST",
      cookie: admin.cookie,
      body: { ledger_id: orig!.id, reason: "mistake" },
    });
    expect(rev.status).toBe(200);

    // Correct (freeform +).
    const corr = await request(`/admin/users/${student.id}/points/correct`, {
      method: "POST",
      cookie: admin.cookie,
      body: { delta: 10, reason: "system miss" },
    });
    expect(corr.status).toBe(200);

    const actions = (
      await db.select({ a: auditLogs.action }).from(auditLogs).where(eq(auditLogs.targetUserId, student.id))
    ).map((r) => r.a);
    expect(actions).toContain("point_award"); // the original give
    expect(actions).toContain("point_reverse"); // distinct code §15.5
    expect(actions).toContain("point_correct"); // distinct code §15.5
  });
});
