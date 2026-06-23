import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { pointSettings } from "../src/db/schema/point-config";
import { registrations } from "../src/db/schema/registrations";
import { users } from "../src/db/schema/users";
import { pointLedger } from "../src/db/schema/points";
import { auditLogs } from "../src/db/schema/audit";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";
import type { Event } from "../src/db/schema/events";

// ---------------------------------------------------------------------------
// Walk-in (gate) endpoint — POST /events/:eventId/walkin
// Staff/admin create a brand-new no-account student + register (+ optional check-in) in one tx.
// ---------------------------------------------------------------------------

// Walk-in hard-requires an ACTIVE form version (else no_active_form), like every register path.
async function makeWalkinEvent(opts: Parameters<typeof makeEvent>[0] = {}): Promise<Event> {
  const event = await makeEvent({ status: "published", ...opts });
  await db.insert(eventFormVersions).values({
    eventId: event.id,
    versionNumber: 1,
    schemaJson: { fields: [] },
    createdByAdminId: event.createdByAdminId,
    isActive: true,
  });
  return event;
}

let sidSeq = 0; // unique student_ids per worker so dup tests are deterministic
function uniqueStudentId(): string {
  return `walkin-${Date.now()}-${++sidSeq}`;
}

function walkin(eventId: string, cookie: string, body: Record<string, unknown>) {
  return request(`/events/${eventId}/walkin`, { method: "POST", cookie, body });
}

// Minimal valid walk-in body (form is fully relaxed, so answers can stay empty).
function walkinBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    full_name: "Walk In Student",
    student_id: uniqueStudentId(),
    reason: "gate walk-in",
    ...over,
  };
}

async function balanceOf(userId: string): Promise<number> {
  const [u] = await db.select({ b: users.pointsBalance }).from(users).where(eq(users.id, userId));
  return u!.b;
}

async function ledgerSum(userId: string): Promise<number> {
  const [r] = await db
    .select({ s: sql<number>`coalesce(sum(${pointLedger.delta}),0)::int` })
    .from(pointLedger)
    .where(eq(pointLedger.userId, userId));
  return r!.s;
}

async function userCount(): Promise<number> {
  const [r] = await db.select({ c: sql<number>`count(*)::int` }).from(users);
  return r!.c;
}

async function regCount(eventId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(registrations)
    .where(eq(registrations.eventId, eventId));
  return r!.c;
}

// Count audit rows for a given action on a registration (over-capacity is audited per new reg).
async function auditCount(action: string, registrationId: string): Promise<number> {
  const [r] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(and(eq(auditLogs.action, action), eq(auditLogs.registrationId, registrationId)));
  return r!.c;
}

describe("walk-in: happy path (new student + register + check-in + points)", () => {
  it("open check-in window → creates student, registers, checks in, awards 20, source=walkin", async () => {
    const event = await makeWalkinEvent(); // default windows null → check-in window OPEN
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: true }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string; role: string; claimed: boolean };
      registration: { status: string; registrationSource: string; checkinMethod: string | null };
      qrToken: string | null;
      checkedIn: boolean;
      checkinSkipped?: string;
      pointsAwarded: number;
      dryRun: boolean;
    };

    expect(body.dryRun).toBe(false);
    expect(body.checkedIn).toBe(true);
    expect(body.checkinSkipped).toBeUndefined();
    expect(body.pointsAwarded).toBe(20);
    expect(body.qrToken).toBeTruthy();
    expect(body.user.role).toBe("student");
    expect(body.user.claimed).toBe(false); // CLAIM mode — not yet self-claimed
    expect(body.registration.status).toBe("checked_in");
    expect(body.registration.registrationSource).toBe("walkin");
    expect(body.registration.checkinMethod).toBe("walkin");

    // Points landed and cache == truth.
    expect(await balanceOf(body.user.id)).toBe(20);
    expect(await ledgerSum(body.user.id)).toBe(20);

    // Ledger metadata records honest provenance (scanMethod=walkin).
    const [entry] = await db
      .select()
      .from(pointLedger)
      .where(and(eq(pointLedger.userId, body.user.id), eq(pointLedger.reasonCode, "checkin_in")));
    expect((entry!.metadata as { scanMethod?: string }).scanMethod).toBe("walkin");
  });

  it("checkin_now=false → registers only (no check-in, no points), source=walkin", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: false }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      registration: { status: string; registrationSource: string };
      checkedIn: boolean;
      pointsAwarded: number;
    };
    expect(body.checkedIn).toBe(false);
    expect(body.pointsAwarded).toBe(0);
    expect(body.registration.status).toBe("registered");
    expect(body.registration.registrationSource).toBe("walkin");
    expect(await balanceOf(body.user.id)).toBe(0);
  });

  it("checkin_now=false, source=normal → admin desk can override provenance to normal", async () => {
    const event = await makeWalkinEvent();
    const admin = await loginAs("admin");

    const res = await walkin(event.id, admin.cookie, walkinBody({ checkin_now: false, source: "normal" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      registration: { status: string; registrationSource: string };
    };
    expect(body.registration.status).toBe("registered");
    expect(body.registration.registrationSource).toBe("normal");
  });
});

describe("walk-in: บรรพ (group_number) is staff-assignable", () => {
  it("group_number → persisted to the user row + echoed in the response", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: false, group_number: 7 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { id: string; group_number: number | null } };
    expect(body.user.group_number).toBe(7);

    const [u] = await db.select({ g: users.groupNumber }).from(users).where(eq(users.id, body.user.id));
    expect(u!.g).toBe(7);
  });

  it("dry_run reflects group_number without writing", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ group_number: 12, dry_run: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { group_number: number | null }; dryRun: boolean };
    expect(body.dryRun).toBe(true);
    expect(body.user.group_number).toBe(12);
  });

  it("high group_number (>16) → accepted, persisted (no upper cap)", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ group_number: 99 }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { user: { group_number: number | null } };
    expect(body.user.group_number).toBe(99);
  });

  it("non-positive group_number (<1) → 400, nothing created", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const before = await userCount();
    const res = await walkin(event.id, staff.cookie, walkinBody({ group_number: 0 }));
    expect(res.status).toBe(400);
    expect(await userCount()).toBe(before);
  });
});

describe("walk-in: dry_run previews without persisting anything", () => {
  it("dry_run=true → 200 preview, NO user/registration/ledger rows written", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const usersBefore = await userCount();
    const regsBefore = await regCount(event.id);

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: true, dry_run: true }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string };
      registration: { status: string; registrationSource: string };
      qrToken: string | null;
      checkedIn: boolean;
      dryRun: boolean;
    };
    expect(body.dryRun).toBe(true);
    expect(body.checkedIn).toBe(true); // preview says it WOULD check in (window open)
    expect(body.qrToken).toBeNull();
    expect(body.registration.status).toBe("checked_in");
    expect(body.registration.registrationSource).toBe("walkin");

    // The tx was rolled back via the dry-run sentinel — nothing persisted.
    expect(await userCount()).toBe(usersBefore);
    expect(await regCount(event.id)).toBe(regsBefore);
  });
});

describe("walk-in: existing-account upsert (confirm_reuse gate)", () => {
  // Case 2: real run that matches an existing account WITHOUT confirm_reuse → 409, nothing written.
  it("matched existing student, real run WITHOUT confirm_reuse → 409 user_exists, nothing written", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const sid = uniqueStudentId();
    await seedUser({ role: "student", studentId: sid });

    const usersBefore = await userCount();
    const res = await walkin(event.id, staff.cookie, walkinBody({ student_id: sid }));
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "user_exists" });

    // The 409 gate fires before any insert — no new user, no reg.
    expect(await userCount()).toBe(usersBefore);
    expect(await regCount(event.id)).toBe(0);
  });

  // Case 2 variant: email match (different student_id) without confirm_reuse → also 409, nothing written.
  it("matched by email (different student_id), no confirm_reuse → 409, no second user row", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const email = `walkin-dup-${Date.now()}-${++sidSeq}@example.test`;
    await seedUser({ role: "student", email });

    const before = await userCount();
    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: uniqueStudentId(), email }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "user_exists" });
    expect(await userCount()).toBe(before);
    expect(await regCount(event.id)).toBe(0);
  });

  // Case 3: dry_run on an existing student (no confirm needed for preview) → previews EXISTING profile, no writes.
  it("dry_run on existing student (no confirm_reuse) → 200 preview of the EXISTING account, nothing persisted", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const sid = uniqueStudentId();
    // Seed with a distinct profile so we can prove the preview shows the EXISTING data, not the typed body.
    const existing = await seedUser({
      role: "student",
      studentId: sid,
      fullName: "Existing Real Name",
      groupNumber: 5,
    });

    const usersBefore = await userCount();
    const regsBefore = await regCount(event.id);
    // Body carries a DIFFERENT full_name/group_number — must be ignored in favor of the existing account.
    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: sid, full_name: "Typed Name Ignored", group_number: 99, dry_run: true }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      user: { id: string; full_name: string; group_number: number | null };
      matchedExisting: { found: boolean; existingRegStatus: string };
      dryRun: boolean;
    };
    expect(body.dryRun).toBe(true);
    expect(body.matchedExisting.found).toBe(true);
    expect(body.matchedExisting.existingRegStatus).toBe("none");
    // preview.user is the EXISTING account, not the typed body.
    expect(body.user.id).toBe(existing.id);
    expect(body.user.full_name).toBe("Existing Real Name");
    expect(body.user.group_number).toBe(5);

    // Nothing persisted by the preview.
    expect(await userCount()).toBe(usersBefore);
    expect(await regCount(event.id)).toBe(regsBefore);
  });

  // Case 1: existing student, NOT registered, window CLOSED, confirm_reuse + checkin_now → 201 reuse + stamp pastWindow.
  it("existing unregistered student, CLOSED window, confirm_reuse + checkin_now → reuses user, stamps, pastWindow, profile UNCHANGED", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000); // check-in closed 1h ago
    const event = await makeWalkinEvent({ checkinCloseAt: past });
    const staff = await loginAs("checkin_staff");
    const sid = uniqueStudentId();
    const existing = await seedUser({
      role: "student",
      studentId: sid,
      fullName: "Original Full Name",
      groupNumber: 3,
    });

    const usersBefore = await userCount();
    const res = await walkin(
      event.id,
      staff.cookie,
      // Body carries DIFFERENT profile data — must NOT overwrite the existing account.
      walkinBody({
        student_id: sid,
        full_name: "Overwrite Attempt",
        group_number: 88,
        confirm_reuse: true,
        checkin_now: true,
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string; full_name: string; group_number: number | null };
      registration: { status: string };
      checkedIn: boolean;
      pastWindow: boolean;
      matchedExisting: { found: boolean; existingRegStatus: string };
    };
    expect(body.user.id).toBe(existing.id); // same account reused (no new user row)
    expect(body.checkedIn).toBe(true);
    expect(body.pastWindow).toBe(true);
    expect(body.matchedExisting).toMatchObject({ found: true, existingRegStatus: "none" });
    expect(body.registration.status).toBe("checked_in");

    // No new user row — the existing one was reused.
    expect(await userCount()).toBe(usersBefore);

    // Profile NOT overwritten by the walk-in body.
    const [u] = await db
      .select({ name: users.fullName, grp: users.groupNumber })
      .from(users)
      .where(eq(users.id, existing.id));
    expect(u!.name).toBe("Original Full Name");
    expect(u!.grp).toBe(3);

    // Exactly one reg created for this (event,user).
    expect(await regCount(event.id)).toBe(1);
  });

  // Case 4: existing student already `registered` (open window) + confirm_reuse → checks in, no duplicate reg.
  it("existing student already registered + confirm_reuse → checks in, existingRegStatus=registered, no duplicate reg", async () => {
    const event = await makeWalkinEvent(); // open window
    const sid = uniqueStudentId();
    const existing = await seedUser({ role: "student", studentId: sid });
    await makeRegistration({ event, user: existing, status: "registered" });
    const staff = await loginAs("checkin_staff");

    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: sid, confirm_reuse: true, checkin_now: true }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      registration: { status: string };
      checkedIn: boolean;
      pointsAwarded: number;
      matchedExisting: { found: boolean; existingRegStatus: string };
    };
    expect(body.user.id).toBe(existing.id);
    expect(body.checkedIn).toBe(true);
    expect(body.pointsAwarded).toBe(20);
    expect(body.matchedExisting).toMatchObject({ found: true, existingRegStatus: "registered" });
    expect(body.registration.status).toBe("checked_in");

    // unique(event,user) respected — the pre-existing reg was reused, not duplicated.
    expect(await regCount(event.id)).toBe(1);
  });

  // Case 5: existing student already `checked_in` → idempotent, no second point ledger row.
  it("existing student already checked_in + confirm_reuse → idempotent (0 pts, no second ledger row)", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    const existing = await seedUser({ role: "student", studentId: sid });
    // Pre-check-in and award once so we can assert no second leg lands.
    const reg = await makeRegistration({ event, user: existing, status: "checked_in" });
    await db
      .update(registrations)
      .set({ checkedInAt: new Date(), checkinMethod: "manual_search" })
      .where(eq(registrations.id, reg.id));
    const staff = await loginAs("checkin_staff");

    const ledgerBefore = await ledgerSum(existing.id);
    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: sid, confirm_reuse: true, checkin_now: true }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      checkedIn: boolean;
      pointsAwarded: number;
      matchedExisting: { found: boolean; existingRegStatus: string };
    };
    expect(body.checkedIn).toBe(true);
    expect(body.pointsAwarded).toBe(0); // no re-award on idempotent re-check-in
    expect(body.matchedExisting).toMatchObject({ found: true, existingRegStatus: "checked_in" });

    // No new point ledger row — ledger sum unchanged.
    expect(await ledgerSum(existing.id)).toBe(ledgerBefore);
    expect(await regCount(event.id)).toBe(1);
  });

  // Case 6: existing student with cancelled reg + confirm_reuse → revived to registered + checked in.
  it("existing student with cancelled reg + confirm_reuse → revived to registered, then checked in", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    const existing = await seedUser({ role: "student", studentId: sid });
    await makeRegistration({ event, user: existing, status: "cancelled" });
    const staff = await loginAs("checkin_staff");

    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: sid, confirm_reuse: true, checkin_now: true }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      registration: { status: string };
      checkedIn: boolean;
      matchedExisting: { found: boolean; existingRegStatus: string };
    };
    expect(body.checkedIn).toBe(true);
    expect(body.registration.status).toBe("checked_in");
    // existingRegStatus reflects the PRE-revive state.
    expect(body.matchedExisting).toMatchObject({ found: true, existingRegStatus: "cancelled" });
    expect(await regCount(event.id)).toBe(1); // revived in place, no duplicate
  });

  // Case 7: existing student with waitlisted reg + confirm_reuse → revived to registered + checked in.
  it("existing student with waitlisted reg + confirm_reuse → revived to registered, then checked in", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    const existing = await seedUser({ role: "student", studentId: sid });
    await makeRegistration({ event, user: existing, status: "waitlisted" });
    const staff = await loginAs("checkin_staff");

    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: sid, confirm_reuse: true, checkin_now: true }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      registration: { status: string };
      checkedIn: boolean;
      matchedExisting: { found: boolean; existingRegStatus: string };
    };
    expect(body.checkedIn).toBe(true);
    expect(body.registration.status).toBe("checked_in");
    expect(body.matchedExisting).toMatchObject({ found: true, existingRegStatus: "waitlisted" });
    expect(await regCount(event.id)).toBe(1);
  });

  // Case 8: matched account is privileged (admin/staff) → 409 cannot_walkin_privileged, nothing written.
  it("matched account with role=admin + confirm_reuse → 409 cannot_walkin_privileged, nothing written", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const sid = uniqueStudentId();
    await seedUser({ role: "admin", studentId: sid });

    const usersBefore = await userCount();
    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: sid, confirm_reuse: true, checkin_now: true }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "cannot_walkin_privileged" });

    // Guard fires before any write.
    expect(await userCount()).toBe(usersBefore);
    expect(await regCount(event.id)).toBe(0);
  });

  it("matched account with role=checkin_staff + confirm_reuse → 409 cannot_walkin_privileged", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const sid = uniqueStudentId();
    await seedUser({ role: "checkin_staff", studentId: sid });

    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: sid, confirm_reuse: true }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "cannot_walkin_privileged" });
  });

  // Case 10: brand-new user (no match) still works AND reports matchedExisting.found=false.
  it("brand-new user (no match) → 201, matchedExisting={found:false, existingRegStatus:'none'}", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: true }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      checkedIn: boolean;
      pointsAwarded: number;
      matchedExisting: { found: boolean; existingRegStatus: string };
      pastWindow: boolean;
    };
    expect(body.checkedIn).toBe(true);
    expect(body.pointsAwarded).toBe(20);
    expect(body.pastWindow).toBe(false); // open window
    expect(body.matchedExisting).toMatchObject({ found: false, existingRegStatus: "none" });
  });
});

describe("walk-in: closed PAST points cutoff still stamps but awards 0", () => {
  // Case 9: cutoff frozen → check-in stamp still lands but no points / no ledger row.
  it("past cutoff + closed window + confirm-not-needed (new user) → stamped, pointsAwarded=0, no ledger row", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000); // window closed
    const event = await makeWalkinEvent({ checkinCloseAt: past });
    // Singleton point_settings row with a past cutoff → student earning is frozen.
    await db
      .insert(pointSettings)
      .values({ id: 1, cutoffAt: new Date(Date.now() - 60_000) })
      .onConflictDoUpdate({ target: pointSettings.id, set: { cutoffAt: new Date(Date.now() - 60_000) } });
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: true }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      registration: { status: string };
      checkedIn: boolean;
      pastWindow: boolean;
      pointsAwarded: number;
    };
    // Stamp still happens (gate override), but the cutoff self-guard suppresses the award.
    expect(body.checkedIn).toBe(true);
    expect(body.pastWindow).toBe(true);
    expect(body.registration.status).toBe("checked_in");
    expect(body.pointsAwarded).toBe(0);

    // No point ledger row, balance stays 0.
    expect(await ledgerSum(body.user.id)).toBe(0);
    expect(await balanceOf(body.user.id)).toBe(0);
  });
});

describe("walk-in: over-capacity is captured (not blocked) and audited", () => {
  it("event at capacity → 201 success + admin_register_over_capacity audit row for the new reg", async () => {
    // Capacity 1, already met by one existing checked-in reg → next walk-in is over capacity.
    const event = await makeWalkinEvent({ capacity: 1 });
    await makeRegistration({ event, status: "checked_in" });
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: false }));
    expect(res.status).toBe(201); // mirrors admin manual register — over-capacity never blocks
    const body = (await res.json()) as {
      user: { id: string };
      registration: { id: string; status: string };
    };
    expect(body.registration.status).toBe("registered");

    // Over-capacity is audited against the freshly-created reg, with the count/limit + walkin marker.
    expect(await auditCount("admin_register_over_capacity", body.registration.id)).toBe(1);
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "admin_register_over_capacity"),
          eq(auditLogs.registrationId, body.registration.id),
        ),
      );
    expect(audit!.entityType).toBe("registration");
    expect(audit!.targetUserId).toBe(body.user.id);
    expect(audit!.metadata as Record<string, unknown>).toMatchObject({
      count: 1,
      limit: 1,
      walkin: true,
    });

    // The walk-in reg really landed (2 regs now: the pre-existing one + this one).
    expect(await regCount(event.id)).toBe(2);
  });
});

describe("walk-in: rejected when the event can't be registered into", () => {
  it("event has no active form version → 400 no_active_form, nothing created", async () => {
    // Note: makeEvent (not makeWalkinEvent) → published event WITHOUT a form version.
    const event = await makeEvent({ status: "published" });
    const staff = await loginAs("checkin_staff");

    const before = await userCount();
    const res = await walkin(event.id, staff.cookie, walkinBody());
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_active_form" });

    expect(await userCount()).toBe(before);
    expect(await regCount(event.id)).toBe(0);
  });

  it("event not published (draft) → 400 event_not_published, nothing created", async () => {
    // Has an active form version, but status=draft → the publish gate must reject first.
    const event = await makeWalkinEvent({ status: "draft" });
    const staff = await loginAs("checkin_staff");

    const before = await userCount();
    const res = await walkin(event.id, staff.cookie, walkinBody());
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "event_not_published" });

    expect(await userCount()).toBe(before);
    expect(await regCount(event.id)).toBe(0);
  });
});

describe("walk-in: check-in window not yet open now STAMPS anyway (gate override)", () => {
  it("checkin_now=true but check-in opens in the future → user+reg created, STAMPED, pastWindow=true", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // check-in opens 1h from now
    const event = await makeWalkinEvent({ checkinOpenAt: future });
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: true }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      registration: { status: string };
      checkedIn: boolean;
      checkinSkipped?: string;
      pastWindow: boolean;
      pointsAwarded: number;
    };
    // New behavior: stamp always happens when checkin_now; pre-open window is just a gate override.
    expect(body.checkedIn).toBe(true);
    expect(body.checkinSkipped).toBeUndefined();
    expect(body.pastWindow).toBe(true);
    expect(body.registration.status).toBe("checked_in");

    const [reg] = await db.select().from(registrations).where(eq(registrations.eventId, event.id));
    expect(reg!.status).toBe("checked_in");
    expect(reg!.checkedInAt).not.toBeNull();
  });
});

describe("walk-in: closed check-in window now STAMPS anyway (gate override)", () => {
  it("checkin_now=true but window CLOSED → user+reg created, STAMPED, pastWindow=true, points still awarded (cutoff open)", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000); // check-in closed 1h ago
    const event = await makeWalkinEvent({ checkinCloseAt: past });
    const staff = await loginAs("checkin_staff");

    const res = await walkin(event.id, staff.cookie, walkinBody({ checkin_now: true }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      user: { id: string };
      registration: { status: string };
      checkedIn: boolean;
      checkinSkipped?: string;
      pastWindow: boolean;
      pointsAwarded: number;
    };
    // New behavior: closed window no longer skips — stamp happens, flagged pastWindow.
    expect(body.checkedIn).toBe(true);
    expect(body.checkinSkipped).toBeUndefined();
    expect(body.pastWindow).toBe(true);
    expect(body.registration.status).toBe("checked_in");
    // Points cutoff is open (no pointSettings row) → award still lands.
    expect(body.pointsAwarded).toBe(20);

    const [reg] = await db.select().from(registrations).where(eq(registrations.eventId, event.id));
    expect(reg!.status).toBe("checked_in");
    expect(reg!.checkedInAt).not.toBeNull();
    expect(await balanceOf(body.user.id)).toBe(20);
  });
});

describe("walk-in: full_name optional (only required to mint a NEW account)", () => {
  it("new user WITHOUT full_name → 400 full_name_required, nothing created", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const before = await userCount();
    // walkinBody includes full_name by default — strip it for the new-account path.
    const body = walkinBody();
    delete body.full_name;
    const res = await walkin(event.id, staff.cookie, body);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "full_name_required" });

    expect(await userCount()).toBe(before);
    expect(await regCount(event.id)).toBe(0);
  });

  it("new user WITHOUT full_name on dry_run → 400 full_name_required (preview surfaces it too)", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const body = walkinBody({ dry_run: true });
    delete body.full_name;
    const res = await walkin(event.id, staff.cookie, body);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "full_name_required" });
  });

  it("existing-account reuse WITHOUT full_name (+confirm_reuse) → 201 (name not needed, profile untouched)", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    const existing = await seedUser({ role: "student", studentId: sid, fullName: "Existing Name" });
    const staff = await loginAs("checkin_staff");

    const body = walkinBody({ student_id: sid, confirm_reuse: true, checkin_now: false });
    delete body.full_name;
    const res = await walkin(event.id, staff.cookie, body);
    expect(res.status).toBe(201);
    const json = (await res.json()) as { user: { id: string; full_name: string } };
    expect(json.user.id).toBe(existing.id);
    expect(json.user.full_name).toBe("Existing Name"); // reuse never overwrites the profile

    const [u] = await db.select({ name: users.fullName }).from(users).where(eq(users.id, existing.id));
    expect(u!.name).toBe("Existing Name");
  });
});

describe("walk-in lookup: GET /events/:eventId/walkin/lookup", () => {
  function lookup(eventId: string, cookie: string, query: Record<string, string>) {
    const qs = new URLSearchParams(query).toString();
    return request(`/events/${eventId}/walkin/lookup?${qs}`, { method: "GET", cookie });
  }

  it("no matching student_id → found:false, eligible:false, user:null, existingRegStatus:none", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");

    const res = await lookup(event.id, staff.cookie, { student_id: uniqueStudentId() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      eligible: boolean;
      ineligibleReason: string | null;
      user: unknown;
      existingRegStatus: string;
    };
    expect(body).toMatchObject({
      found: false,
      eligible: false,
      ineligibleReason: null,
      user: null,
      existingRegStatus: "none",
    });
  });

  it("existing student not registered → found:true, eligible:true, existingRegStatus:none, profile echoed", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    await seedUser({
      role: "student",
      studentId: sid,
      fullName: "Lookup Student",
      groupNumber: 4,
    });
    const staff = await loginAs("checkin_staff");

    const res = await lookup(event.id, staff.cookie, { student_id: sid });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      eligible: boolean;
      ineligibleReason: string | null;
      user: { full_name: string; student_id: string; group_number: number | null; role: string; status: string };
      existingRegStatus: string;
    };
    expect(body.found).toBe(true);
    expect(body.eligible).toBe(true);
    expect(body.ineligibleReason).toBeNull();
    expect(body.existingRegStatus).toBe("none");
    expect(body.user).toMatchObject({
      full_name: "Lookup Student",
      student_id: sid,
      group_number: 4,
      role: "student",
      status: "active",
    });
    // No id leaked in the response.
    expect((body.user as Record<string, unknown>).id).toBeUndefined();
  });

  it("existing student already checked_in → existingRegStatus:checked_in", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    const existing = await seedUser({ role: "student", studentId: sid });
    await makeRegistration({ event, user: existing, status: "checked_in" });
    const staff = await loginAs("checkin_staff");

    const res = await lookup(event.id, staff.cookie, { student_id: sid });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { found: boolean; existingRegStatus: string };
    expect(body.found).toBe(true);
    expect(body.existingRegStatus).toBe("checked_in");
  });

  it("matched account is admin → found:true, eligible:false, ineligibleReason:not_student (user still returned)", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    await seedUser({ role: "admin", studentId: sid });
    const staff = await loginAs("checkin_staff");

    const res = await lookup(event.id, staff.cookie, { student_id: sid });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      eligible: boolean;
      ineligibleReason: string | null;
      user: { role: string } | null;
    };
    expect(body.found).toBe(true);
    expect(body.eligible).toBe(false);
    expect(body.ineligibleReason).toBe("not_student");
    expect(body.user?.role).toBe("admin"); // returned so the UI can explain
  });

  it("inactive (disabled) student → found:true, eligible:false, ineligibleReason:inactive", async () => {
    const event = await makeWalkinEvent();
    const sid = uniqueStudentId();
    await seedUser({ role: "student", studentId: sid, status: "disabled" });
    const staff = await loginAs("checkin_staff");

    const res = await lookup(event.id, staff.cookie, { student_id: sid });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      eligible: boolean;
      ineligibleReason: string | null;
    };
    expect(body.found).toBe(true);
    expect(body.eligible).toBe(false);
    expect(body.ineligibleReason).toBe("inactive");
  });

  it("plain student calling lookup → 403 (canWalkinRegister denies)", async () => {
    const event = await makeWalkinEvent();
    const student = await loginAs("student");

    const res = await lookup(event.id, student.cookie, { student_id: uniqueStudentId() });
    expect(res.status).toBe(403);
  });
});

describe("walk-in: permission", () => {
  it("checkin_staff is allowed", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const res = await walkin(event.id, staff.cookie, walkinBody());
    expect(res.status).toBe(201);
  });

  it("admin is allowed", async () => {
    const event = await makeWalkinEvent();
    const admin = await loginAs("admin");
    const res = await walkin(event.id, admin.cookie, walkinBody());
    expect(res.status).toBe(201);
  });

  it("plain student is forbidden → 403", async () => {
    const event = await makeWalkinEvent();
    const student = await loginAs("student");
    const res = await walkin(event.id, student.cookie, walkinBody());
    expect(res.status).toBe(403);
  });

  it("unauthenticated → 401", async () => {
    const event = await makeWalkinEvent();
    const res = await walkin(event.id, "", walkinBody());
    expect(res.status).toBe(401);
  });
});
