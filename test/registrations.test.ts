import { describe, it, expect } from "vitest";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations } from "../src/db/schema/registrations";
import { events as eventsTable } from "../src/db/schema/events";
import { and, eq, sql } from "drizzle-orm";
import { request } from "./helpers/db";
import { loginAs, seedUser } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";
import type { Event } from "../src/db/schema/events";
import type { FormSchema } from "../src/lib/form-schema";

// ---------------------------------------------------------------------------
// Local helpers (test-only). The harness has no form factory, but the submit
// endpoint hard-requires an ACTIVE form version (else `no_active_form`), so
// every register-path test must seed one. We write the version row directly.
// ---------------------------------------------------------------------------

// Create the active form version an event needs before registration is reachable.
// Default schema = no fields → register body {} validates clean (lets us focus on capacity/dedup).
async function makeFormVersion(
  event: Event,
  schema: FormSchema = { fields: [] },
): Promise<string> {
  const [row] = await db
    .insert(eventFormVersions)
    .values({
      eventId: event.id,
      versionNumber: 1,
      schemaJson: schema,
      createdByAdminId: event.createdByAdminId,
      isActive: true,
    })
    .returning();
  if (!row) throw new Error("makeFormVersion: insert returned no row");
  return row.id;
}

// Event + active form version in one shot (the normal precondition for self-register).
async function makeRegisterableEvent(
  opts: Parameters<typeof makeEvent>[0] = {},
  schema?: FormSchema,
): Promise<Event> {
  const event = await makeEvent(opts);
  await makeFormVersion(event, schema);
  return event;
}

// Submit a self-registration as a logged-in student.
function submitRegister(eventId: string, cookie: string, answers: Record<string, unknown> = {}) {
  return request(`/events/${eventId}/register`, {
    method: "POST",
    cookie,
    body: { answers },
  });
}

// Count active (registered+checked_in) registrations directly — the capacity definition.
async function activeCount(eventId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        sql`${registrations.status} in ('registered','checked_in')`,
      ),
    );
  return row?.c ?? 0;
}

// All registration rows for an event (to assert no-hard-delete + row counts).
async function allRegs(eventId: string) {
  return db.select().from(registrations).where(eq(registrations.eventId, eventId));
}

// Pre-seed N distinct logged-in students (each own cookie) for concurrent fire.
async function seedStudents(n: number): Promise<{ cookie: string }[]> {
  const out: { cookie: string }[] = [];
  for (let i = 0; i < n; i++) {
    const { cookie } = await loginAs("student");
    out.push({ cookie });
  }
  return out;
}

describe("registrations: self-register happy path", () => {
  it("student self-registers on a public event → 201 registered + QR token + audit", async () => {
    const event = await makeRegisterableEvent();
    const { user, cookie } = await loginAs("student");

    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      registration: { status: string; userId: string };
      qrToken: string | null;
      alreadyRegistered: boolean;
    };
    expect(body.registration.status).toBe("registered");
    expect(body.registration.userId).toBe(user.id);
    expect(body.alreadyRegistered).toBe(false);
    expect(body.qrToken).toBeTruthy(); // QR issued once for registered

    expect(await activeCount(event.id)).toBe(1);
  });

  it("event with no active form version → 400 no_active_form", async () => {
    const event = await makeEvent(); // no form version seeded
    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "no_active_form" });
  });

  it("unauthenticated submit → 401", async () => {
    const event = await makeRegisterableEvent();
    const res = await request(`/events/${event.id}/register`, { method: "POST", body: { answers: {} } });
    expect(res.status).toBe(401);
  });

  it("unknown event id → 404", async () => {
    const { cookie } = await loginAs("student");
    const res = await submitRegister("00000000-0000-0000-0000-000000000000", cookie);
    expect(res.status).toBe(404);
  });
});

describe("registrations: capacity race (marquee)", () => {
  // The critical invariant: tx + SELECT ... FOR UPDATE must serialize concurrent submits so
  // capacity can never be oversold. Each student gets a distinct cookie; we fire all at once.
  it("capacity=1, 8 distinct students fire concurrently → EXACTLY 1 registered, rest 409 full", async () => {
    const event = await makeRegisterableEvent({ capacity: 1 });
    const students = await seedStudents(8);

    const responses = await Promise.all(students.map((s) => submitRegister(event.id, s.cookie)));
    const statuses = responses.map((r) => r.status);

    const won = statuses.filter((s) => s === 201).length;
    const full = statuses.filter((s) => s === 409).length;

    // Marquee assertion: no overselling.
    expect(won).toBe(1);
    expect(full).toBe(7);
    expect(await activeCount(event.id)).toBe(1);

    // Losers must carry the capacity-full error shape.
    const fullBodies = await Promise.all(
      responses.filter((r) => r.status === 409).map((r) => r.json() as Promise<{ error: string }>),
    );
    for (const b of fullBodies) expect(b.error).toBe("registration_full");
  });

  it("capacity=2, 8 distinct students fire concurrently → EXACTLY 2 registered, rest 409", async () => {
    const event = await makeRegisterableEvent({ capacity: 2 });
    const students = await seedStudents(8);

    const responses = await Promise.all(students.map((s) => submitRegister(event.id, s.cookie)));
    const won = responses.filter((r) => r.status === 201).length;

    expect(won).toBe(2);
    expect(await activeCount(event.id)).toBe(2);
  });

  it("no capacity limit → all concurrent submits succeed", async () => {
    const event = await makeRegisterableEvent(); // unlimited
    const students = await seedStudents(6);
    const responses = await Promise.all(students.map((s) => submitRegister(event.id, s.cookie)));
    expect(responses.every((r) => r.status === 201)).toBe(true);
    expect(await activeCount(event.id)).toBe(6);
  });

  it("capacity count EXCLUDES cancelled — a cancelled reg frees a slot for a new student", async () => {
    const event = await makeRegisterableEvent({ capacity: 1, status: "published" });
    // Pre-seed a cancelled reg (should NOT count toward capacity).
    await makeRegistration({ event, status: "cancelled" });
    expect(await activeCount(event.id)).toBe(0);

    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(201); // slot was free despite the cancelled row existing
    expect(await activeCount(event.id)).toBe(1);
  });

  it("capacity count EXCLUDES waitlisted — waitlisted does not consume a slot", async () => {
    // capacity counting is registered+checked_in only; waitlisted should not block a register.
    const event = await makeRegisterableEvent({ capacity: 1 });
    await makeRegistration({ event, status: "waitlisted" });
    expect(await activeCount(event.id)).toBe(0);

    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(201);
  });

  it("checked_in registrations DO count toward capacity", async () => {
    const event = await makeRegisterableEvent({ capacity: 1 });
    await makeRegistration({ event, status: "checked_in" });
    expect(await activeCount(event.id)).toBe(1);

    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "registration_full" });
  });
});

describe("registrations: unique(event_id, user_id) dedup", () => {
  it("same user submits twice → second is idempotent (200, alreadyRegistered), one row only", async () => {
    const event = await makeRegisterableEvent();
    const { cookie } = await loginAs("student");

    const first = await submitRegister(event.id, cookie);
    expect(first.status).toBe(201);

    const second = await submitRegister(event.id, cookie);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { alreadyRegistered: boolean; qrToken: string | null };
    expect(body.alreadyRegistered).toBe(true);
    expect(body.qrToken).toBeNull(); // existing reg path returns no new token

    const rows = await allRegs(event.id);
    expect(rows.length).toBe(1); // exactly one registration row
  });

  it("concurrent double-submit from the SAME user → still one row (unique constraint holds)", async () => {
    const event = await makeRegisterableEvent();
    const { cookie } = await loginAs("student");

    const [a, b] = await Promise.all([
      submitRegister(event.id, cookie),
      submitRegister(event.id, cookie),
    ]);
    // Both should resolve (one 201 create, one 200 idempotent) OR one may hit a transient conflict.
    expect([a.status, b.status].every((s) => s === 200 || s === 201)).toBe(true);
    const rows = await allRegs(event.id);
    expect(rows.length).toBe(1);
  });
});

describe("registrations: status lifecycle (cancel) + no hard delete", () => {
  it("student cancels own reg → row stays as 'cancelled' (no hard delete), QR gone", async () => {
    // Event must allow student cancel.
    const event = await makeRegisterableEvent({});
    await db
      .update(eventsTable)
      .set({ allowStudentCancelRegistration: true })
      .where(eq(eventsTable.id, event.id));
    const { cookie } = await loginAs("student");

    const reg = await submitRegister(event.id, cookie);
    const regId = ((await reg.json()) as { registration: { id: string } }).registration.id;

    const cancel = await request(`/registrations/${regId}/cancel`, { method: "POST", cookie });
    expect(cancel.status).toBe(200);
    expect((await cancel.json()) as { ok: boolean }).toEqual({ ok: true });

    const rows = await allRegs(event.id);
    expect(rows.length).toBe(1); // still present — soft lifecycle
    expect(rows[0]?.status).toBe("cancelled");
    expect(rows[0]?.cancelledAt).not.toBeNull();
    expect(await activeCount(event.id)).toBe(0); // slot freed
  });

  it("cancelling frees a capacity slot for another student", async () => {
    const event = await makeRegisterableEvent({ capacity: 1 });
    await db
      .update(eventsTable)
      .set({ allowStudentCancelRegistration: true })
      .where(eq(eventsTable.id, event.id));

    const s1 = await loginAs("student");
    const r1 = await submitRegister(event.id, s1.cookie);
    expect(r1.status).toBe(201);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    // Second student blocked while full.
    const s2 = await loginAs("student");
    expect((await submitRegister(event.id, s2.cookie)).status).toBe(409);

    // s1 cancels → slot frees.
    expect((await request(`/registrations/${regId}/cancel`, { method: "POST", cookie: s1.cookie })).status).toBe(200);

    // s2 can now take it.
    expect((await submitRegister(event.id, s2.cookie)).status).toBe(201);
    expect(await activeCount(event.id)).toBe(1);
  });

  it("cancelled student can re-register → existing row REACTIVATED (still one row)", async () => {
    const event = await makeRegisterableEvent({});
    await db
      .update(eventsTable)
      .set({ allowStudentCancelRegistration: true })
      .where(eq(eventsTable.id, event.id));
    const { cookie } = await loginAs("student");

    const r1 = await submitRegister(event.id, cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;
    await request(`/registrations/${regId}/cancel`, { method: "POST", cookie });

    const r2 = await submitRegister(event.id, cookie);
    expect(r2.status).toBe(201); // reactivation path returns 201 (alreadyExisted=false)
    const body = (await r2.json()) as { registration: { id: string; status: string } };
    expect(body.registration.id).toBe(regId); // same row reactivated, not a new one
    expect(body.registration.status).toBe("registered");

    const rows = await allRegs(event.id);
    expect(rows.length).toBe(1); // never duplicated, never hard-deleted
  });

  it("cancel when event disallows student cancel → 403", async () => {
    const event = await makeRegisterableEvent({}); // allowStudentCancelRegistration defaults false
    const { cookie } = await loginAs("student");
    const r1 = await submitRegister(event.id, cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    const cancel = await request(`/registrations/${regId}/cancel`, { method: "POST", cookie });
    expect(cancel.status).toBe(403);
  });

  it("cancelling someone else's registration → 403", async () => {
    const event = await makeRegisterableEvent({});
    await db
      .update(eventsTable)
      .set({ allowStudentCancelRegistration: true })
      .where(eq(eventsTable.id, event.id));
    const owner = await loginAs("student");
    const r1 = await submitRegister(event.id, owner.cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    const attacker = await loginAs("student");
    const cancel = await request(`/registrations/${regId}/cancel`, { method: "POST", cookie: attacker.cookie });
    expect(cancel.status).toBe(403);
  });

  it("double cancel → second is 400 already_cancelled (no further row mutation)", async () => {
    const event = await makeRegisterableEvent({});
    await db
      .update(eventsTable)
      .set({ allowStudentCancelRegistration: true })
      .where(eq(eventsTable.id, event.id));
    const { cookie } = await loginAs("student");
    const r1 = await submitRegister(event.id, cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    expect((await request(`/registrations/${regId}/cancel`, { method: "POST", cookie })).status).toBe(200);
    const second = await request(`/registrations/${regId}/cancel`, { method: "POST", cookie });
    expect(second.status).toBe(400);
    expect((await second.json()) as { error: string }).toMatchObject({ error: "already_cancelled" });
  });
});

describe("registrations: event-state gating on submit", () => {
  it("unpublished (draft) event → 400 event_not_open", async () => {
    const event = await makeRegisterableEvent({ status: "draft" });
    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "event_not_open" });
  });

  it("registrationMode=closed → 403 (self-register not allowed)", async () => {
    const event = await makeRegisterableEvent({ registrationMode: "closed" });
    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(403);
  });

  it("registration window not yet open → 400 registration_closed", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000); // opens in 1h
    const event = await makeRegisterableEvent({ registrationOpenAt: future });
    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "registration_closed" });
  });

  it("registration window already closed → 400 registration_closed", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000); // closed 1h ago
    const event = await makeRegisterableEvent({ registrationCloseAt: past });
    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "registration_closed" });
  });
});

describe("registrations: capacity full without waitlist vs with waitlist", () => {
  it("full + waitlist disabled → 409 registration_full", async () => {
    const event = await makeRegisterableEvent({ capacity: 1 });
    const blocker = await loginAs("student");
    expect((await submitRegister(event.id, blocker.cookie)).status).toBe(201);

    const second = await loginAs("student");
    const res = await submitRegister(event.id, second.cookie);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "registration_full" });
  });

  it("full + waitlist enabled → register endpoint auto-waitlists (201 waitlisted, no QR)", async () => {
    const event = await makeRegisterableEvent({ capacity: 1 });
    await db
      .update(eventsTable)
      .set({ waitlistEnabled: true })
      .where(eq(eventsTable.id, event.id));

    const blocker = await loginAs("student");
    expect((await submitRegister(event.id, blocker.cookie)).status).toBe(201);

    const second = await loginAs("student");
    const res = await submitRegister(event.id, second.cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { registration: { status: string }; qrToken: string | null };
    expect(body.registration.status).toBe("waitlisted");
    expect(body.qrToken).toBeNull(); // waitlisted gets no QR until promoted
    expect(await activeCount(event.id)).toBe(1); // waitlisted not counted
  });
});

describe("registrations: Zod validation of required form answers", () => {
  it("missing a required non-file field → 400 invalid_form_answers", async () => {
    // Seed a schema with one required short_text field.
    const event = await makeRegisterableEvent(
      {},
      { fields: [{ key: "name", type: "short_text", label: "Name", required: true, sort: 0 }] },
    );
    const { cookie } = await loginAs("student");

    const res = await submitRegister(event.id, cookie, {}); // omit required answer
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_form_answers" });
  });

  it("supplying the required answer → 201 registered", async () => {
    const event = await makeRegisterableEvent(
      {},
      { fields: [{ key: "name", type: "short_text", label: "Name", required: true, sort: 0 }] },
    );
    const { cookie } = await loginAs("student");

    const res = await submitRegister(event.id, cookie, { name: "Somchai" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { registration: { status: string } }).registration.status).toBe("registered");
  });

  it("unknown answer key not in schema → 400 invalid_form_answers", async () => {
    const event = await makeRegisterableEvent({}, { fields: [] });
    const { cookie } = await loginAs("student");
    const res = await submitRegister(event.id, cookie, { stray: "x" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_form_answers" });
  });
});

describe("registrations: admin manual register over-capacity override", () => {
  it("admin can register a user past capacity (override) → 201, capacity now exceeded", async () => {
    const event = await makeRegisterableEvent({ capacity: 1 });
    // Fill the one slot via a student self-register.
    const filler = await loginAs("student");
    expect((await submitRegister(event.id, filler.cookie)).status).toBe(201);

    const admin = await loginAs("admin");
    const target = await seedUser({ role: "student" });
    const res = await request(`/admin/events/${event.id}/registrations`, {
      method: "POST",
      cookie: admin.cookie,
      body: { userId: target.id, answers: {}, reason: "VIP override" },
    });
    expect(res.status).toBe(201); // admin override ignores capacity
    expect(await activeCount(event.id)).toBe(2); // intentionally over the limit
  });

  it("non-admin (student) hitting admin manual-register → 403", async () => {
    const event = await makeRegisterableEvent({});
    const student = await loginAs("student");
    const target = await seedUser({ role: "student" });
    const res = await request(`/admin/events/${event.id}/registrations`, {
      method: "POST",
      cookie: student.cookie,
      body: { userId: target.id, answers: {}, reason: "nope" },
    });
    expect(res.status).toBe(403);
  });
});
