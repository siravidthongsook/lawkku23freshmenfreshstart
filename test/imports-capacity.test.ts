import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { users } from "../src/db/schema/users";
import { registrations } from "../src/db/schema/registrations";
import { auditLogs } from "../src/db/schema/audit";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";

// ---------------------------------------------------------------------------
// Local helpers (mirror imports-exports.test.ts)
// ---------------------------------------------------------------------------

// Upload a CSV to the preview endpoint as multipart/form-data (field name `file`).
function previewCsv(
  csv: string,
  cookie: string,
  extra: Record<string, string> = {},
  filename = "import.csv",
): Promise<Response> {
  const fd = new FormData();
  fd.set("file", new File([csv], filename, { type: "text/csv" }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return request("/admin/imports/users/preview", { method: "POST", cookie, body: fd });
}

// ---------------------------------------------------------------------------
// Over-capacity import (preview classification + confirm registers anyway + audit)
// ---------------------------------------------------------------------------

describe("user import: over-capacity registration", () => {
  it("classifies new rows past capacity as will_register_over_capacity (preview)", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    // Capacity 1, already 1 live reg → remainingCapacity = 0 for the import.
    const event = await makeEvent({ createdByAdminId: admin.id, capacity: 1 });
    await makeRegistration({ event, status: "registered" });

    const csv = ["email,full_name", "over1@b.test,Over One"].join("\n");
    const res = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      rows: { rowNumber: number; status: string }[];
    };
    const byNum = new Map(body.rows.map((r) => [r.rowNumber, r]));
    // New user past the cap → flagged over-capacity, not plain will_create.
    expect(byNum.get(1)?.status).toBe("will_register_over_capacity");
    expect(body.counts.will_register_over_capacity).toBe(1);
  });

  it("confirm registers over-capacity rows anyway + writes admin_register_over_capacity audit + over_capacity count", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id, capacity: 1 });
    await makeRegistration({ event, status: "registered" }); // fills the single slot

    const csv = ["email,full_name", "over2@b.test,Over Two"].join("\n");
    const prev = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    const { importId } = (await prev.json()) as { importId: string };

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as {
      created: number;
      registered: number;
      over_capacity: number;
    };
    // Registered despite being past capacity (admin override) + counted.
    expect(result.created).toBe(1);
    expect(result.registered).toBe(1);
    expect(result.over_capacity).toBe(1);

    // The new user actually has a registered row in the event.
    const [u] = await db.select().from(users).where(eq(users.email, "over2@b.test"));
    const regs = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, u!.id)));
    expect(regs.length).toBe(1);
    expect(regs[0]?.status).toBe("registered");

    // An admin_register_over_capacity audit row was appended for this user/event.
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "admin_register_over_capacity"),
          eq(auditLogs.targetUserId, u!.id),
        ),
      );
    expect(audit.length).toBe(1);
    expect(audit[0]?.eventId).toBe(event.id);
    expect(audit[0]?.reason).toBe("import register over capacity");
    expect((audit[0]?.metadata as { source: string }).source).toBe("user_import");
  });

  it("will_update branch also flags + registers over capacity (existing user past the cap)", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id, capacity: 1 });
    await makeRegistration({ event, status: "registered" }); // fills cap with a DIFFERENT user

    // Existing user (by email) → import row resolves to will_update, then over capacity.
    await seedUser({ role: "student", email: "upd-over@b.test", studentId: "uo-1" });

    const csv = ["email,full_name,student_id", "upd-over@b.test,Updated Over,uo-1"].join("\n");
    const prev = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    const prevBody = (await prev.json()) as { importId: string; rows: { status: string }[] };
    // Update-branch capacity flag (service.ts:127) — not will_update, escalated to over-capacity.
    expect(prevBody.rows[0]?.status).toBe("will_register_over_capacity");
    const { importId } = prevBody;

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as {
      updated: number;
      registered: number;
      over_capacity: number;
    };
    expect(result.updated).toBe(1);
    expect(result.registered).toBe(1);
    expect(result.over_capacity).toBe(1);

    // Audit row tied to the existing (updated) user.
    const [u] = await db.select().from(users).where(eq(users.email, "upd-over@b.test"));
    const audit = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "admin_register_over_capacity"),
          eq(auditLogs.targetUserId, u!.id),
        ),
      );
    expect(audit.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// DB-conflict duplicate_student_id (student_id owned by a DIFFERENT existing user)
// ---------------------------------------------------------------------------

describe("user import: cross-user duplicate_student_id (DB conflict)", () => {
  it("flags a student_id already owned by a different existing user (service.ts:121)", async () => {
    const { cookie } = await loginAs("admin");
    // Existing user owns student_id "owned-1" under a different email.
    await seedUser({ role: "student", email: "owner@b.test", studentId: "owned-1" });

    // Import row: NEW email, but reuses the existing owner's student_id → cross-user conflict.
    const csv = ["email,full_name,student_id", "intruder@b.test,Intruder,owned-1"].join("\n");
    const res = await previewCsv(csv, cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      counts: Record<string, number>;
      rows: { rowNumber: number; status: string; note?: string }[];
    };
    expect(body.rows[0]?.status).toBe("duplicate_student_id");
    expect(body.rows[0]?.note).toBe("student_id belongs to another user");
    expect(body.counts.duplicate_student_id).toBe(1);
    // No will_create — it was diverted to the conflict branch.
    expect(body.counts.will_create ?? 0).toBe(0);

    // Confirm must NOT create the intruder (duplicate rows are skipped).
    const { importId } = body as unknown as { importId: string };
    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });
    expect(confirm.status).toBe(200);
    const created = await db.select().from(users).where(eq(users.email, "intruder@b.test"));
    expect(created.length).toBe(0);
  });

  it("does NOT flag when the same student_id belongs to the SAME user (email matches) → will_update", async () => {
    // Guards the (!byEmail || byEmail.id !== byStudentId.id) condition: same owner is fine.
    const { cookie } = await loginAs("admin");
    await seedUser({ role: "student", email: "self@b.test", studentId: "self-1" });

    const csv = ["email,full_name,student_id", "self@b.test,Self Updated,self-1"].join("\n");
    const res = await previewCsv(csv, cookie);
    const body = (await res.json()) as { rows: { status: string }[] };
    expect(body.rows[0]?.status).toBe("will_update");
  });
});

// ---------------------------------------------------------------------------
// Revive cancelled/waitlisted registration on import + already-active leave-as-is
// ---------------------------------------------------------------------------

describe("user import: registerUser revive vs leave-as-is (routes.ts:447-455)", () => {
  it("revives a cancelled registration back to registered on import", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    // Existing student with a CANCELLED reg on the target event.
    const student = await seedUser({ role: "student", email: "revive@b.test", studentId: "rv-1" });
    await makeRegistration({ event, user: student, status: "cancelled" });

    const csv = ["email,full_name,student_id", "revive@b.test,Revive Me,rv-1"].join("\n");
    const prev = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    const { importId } = (await prev.json()) as { importId: string };

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as { updated: number; registered: number };
    expect(result.updated).toBe(1);
    expect(result.registered).toBe(1); // revive counts as a registration

    // The single existing reg was flipped to registered (not a duplicate row).
    const regs = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, student.id)));
    expect(regs.length).toBe(1);
    expect(regs[0]?.status).toBe("registered");
    expect(regs[0]?.registeredAt).toBeInstanceOf(Date);
  });

  it("revives a waitlisted registration back to registered on import", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const student = await seedUser({ role: "student", email: "wl@b.test", studentId: "wl-1" });
    await makeRegistration({ event, user: student, status: "waitlisted" });

    const csv = ["email,full_name,student_id", "wl@b.test,Waitlisted,wl-1"].join("\n");
    const prev = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    const { importId } = (await prev.json()) as { importId: string };

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as { registered: number };
    expect(result.registered).toBe(1);

    const regs = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, student.id)));
    expect(regs.length).toBe(1);
    expect(regs[0]?.status).toBe("registered");
  });

  it("leaves an already-registered user as-is (registerUser returns null → not re-counted)", async () => {
    const { cookie, user: admin } = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.id });
    const student = await seedUser({ role: "student", email: "already@b.test", studentId: "al-1" });
    const existing = await makeRegistration({ event, user: student, status: "registered" });
    const originalRegisteredAt = existing.registeredAt;

    const csv = ["email,full_name,student_id", "already@b.test,Already Here,al-1"].join("\n");
    const prev = await previewCsv(csv, cookie, {
      scope: "user_pool_and_register_to_event",
      targetEventId: event.id,
    });
    const { importId } = (await prev.json()) as { importId: string };

    const confirm = await request("/admin/imports/users/confirm", {
      method: "POST",
      cookie,
      body: { importId },
    });
    expect(confirm.status).toBe(200);
    const result = (await confirm.json()) as { updated: number; registered: number };
    expect(result.updated).toBe(1); // profile updated
    expect(result.registered).toBe(0); // already active → NOT counted as a new registration

    // Reg untouched: still registered, still the single row, registeredAt not bumped.
    const regs = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, event.id), eq(registrations.userId, student.id)));
    expect(regs.length).toBe(1);
    expect(regs[0]?.status).toBe("registered");
    expect(regs[0]?.registeredAt?.toISOString()).toBe(originalRegisteredAt?.toISOString());
  });
});
