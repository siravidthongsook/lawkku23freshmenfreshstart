import { describe, it, expect } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
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

describe("walk-in: duplicate student_id is rejected", () => {
  it("existing student_id on file → 409 user_exists", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const sid = uniqueStudentId();
    await seedUser({ role: "student", studentId: sid });

    const res = await walkin(event.id, staff.cookie, walkinBody({ student_id: sid }));
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "user_exists" });
  });

  it("existing email on file (different student_id) → 409 user_exists, no second user row", async () => {
    const event = await makeWalkinEvent();
    const staff = await loginAs("checkin_staff");
    const email = `walkin-dup-${Date.now()}-${++sidSeq}@example.test`;
    await seedUser({ role: "student", email });

    const before = await userCount();
    // Same email, but a brand-new student_id → the email dup guard must still trip.
    const res = await walkin(
      event.id,
      staff.cookie,
      walkinBody({ student_id: uniqueStudentId(), email }),
    );
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "user_exists" });

    // Rejected before any insert — no second user created.
    expect(await userCount()).toBe(before);
    expect(await regCount(event.id)).toBe(0);
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

describe("walk-in: check-in window not yet open still captures the walk-in", () => {
  it("checkin_now=true but check-in opens in the future → user+reg created, check-in skipped, no points", async () => {
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
      pointsAwarded: number;
    };
    expect(body.checkedIn).toBe(false);
    expect(body.checkinSkipped).toBe("checkin_not_open");
    expect(body.pointsAwarded).toBe(0);
    expect(body.registration.status).toBe("registered"); // captured, just not checked in yet

    // Reg row is real but not stamped; no points awarded.
    const [reg] = await db.select().from(registrations).where(eq(registrations.eventId, event.id));
    expect(reg!.status).toBe("registered");
    expect(reg!.checkedInAt).toBeNull();
    expect(await balanceOf(body.user.id)).toBe(0);
  });
});

describe("walk-in: closed check-in window still captures the walk-in", () => {
  it("checkin_now=true but window CLOSED → user+reg created, check-in skipped, no points", async () => {
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
      pointsAwarded: number;
    };
    expect(body.checkedIn).toBe(false);
    expect(body.checkinSkipped).toBe("checkin_closed");
    expect(body.pointsAwarded).toBe(0);
    expect(body.registration.status).toBe("registered"); // reg still created, just not checked in

    // User + reg row are real (the gate captured the walk-in), but no points.
    const [reg] = await db.select().from(registrations).where(eq(registrations.eventId, event.id));
    expect(reg!.status).toBe("registered");
    expect(reg!.checkedInAt).toBeNull();
    expect(await balanceOf(body.user.id)).toBe(0);
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
