import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations } from "../src/db/schema/registrations";
import { registrationQrTokens } from "../src/db/schema/qr";
import { events as eventsTable } from "../src/db/schema/events";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";
import { hashToken } from "../src/lib/crypto";
import type { Event } from "../src/db/schema/events";

// ---------------------------------------------------------------------------
// Lifecycle suite — covers the zero-coverage registration lifecycle endpoints:
// join-waitlist, admin promote/demote, student answer self-edit, owner detail.
// Reuses the active-form-version precondition pattern: /register + /join-waitlist
// + /answers all hard-require an ACTIVE form version, so every reg-path test seeds one.
// ---------------------------------------------------------------------------

// Seed the active form version the register/waitlist/edit paths require.
// Empty schema → body { answers: {} } validates clean (lets us focus on lifecycle).
async function makeFormVersion(event: Event): Promise<void> {
  await db.insert(eventFormVersions).values({
    eventId: event.id,
    versionNumber: 1,
    schemaJson: { fields: [] },
    createdByAdminId: event.createdByAdminId,
    isActive: true,
  });
}

// Published event + active form version → reachable by self-register/waitlist.
async function makeRegisterableEvent(opts: Parameters<typeof makeEvent>[0] = {}): Promise<Event> {
  const event = await makeEvent(opts);
  await makeFormVersion(event);
  return event;
}

function joinWaitlist(eventId: string, cookie?: string, answers: Record<string, unknown> = {}) {
  return request(`/events/${eventId}/join-waitlist`, { method: "POST", cookie, body: { answers } });
}

function submitRegister(eventId: string, cookie: string, answers: Record<string, unknown> = {}) {
  return request(`/events/${eventId}/register`, { method: "POST", cookie, body: { answers } });
}

async function getReg(id: string) {
  const [row] = await db.select().from(registrations).where(eq(registrations.id, id));
  return row;
}

async function activeQrRows(registrationId: string) {
  return db
    .select()
    .from(registrationQrTokens)
    .where(
      and(
        eq(registrationQrTokens.registrationId, registrationId),
        eq(registrationQrTokens.status, "active"),
      ),
    );
}

// Flip event toggles the makeEvent factory doesn't expose.
async function setEvent(eventId: string, patch: Record<string, unknown>) {
  await db.update(eventsTable).set(patch).where(eq(eventsTable.id, eventId));
}

// =====================================================================
// POST /events/:eventId/join-waitlist
// =====================================================================

describe("registrations: join-waitlist", () => {
  it("waitlist enabled → 201 waitlisted row inserted (no QR for waitlisted)", async () => {
    const event = await makeRegisterableEvent();
    await setEvent(event.id, { waitlistEnabled: true });
    const { user, cookie } = await loginAs("student");

    const res = await joinWaitlist(event.id, cookie);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { registration: { id: string; status: string; userId: string }; waitlisted: boolean };
    expect(body.registration.status).toBe("waitlisted");
    expect(body.registration.userId).toBe(user.id);
    expect(body.waitlisted).toBe(true);

    const reg = (await getReg(body.registration.id))!;
    expect(reg.status).toBe("waitlisted");
    expect(reg.waitlistedAt).not.toBeNull();
    // Waitlisted gets no QR until promoted.
    expect((await activeQrRows(reg.id)).length).toBe(0);
  });

  it("unpublished (draft) event → 400 event_not_open", async () => {
    const event = await makeRegisterableEvent({ status: "draft" });
    await setEvent(event.id, { waitlistEnabled: true });
    const { cookie } = await loginAs("student");
    const res = await joinWaitlist(event.id, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "event_not_open" });
  });

  it("registrationMode=closed → 403 (self-service waitlist not allowed)", async () => {
    const event = await makeRegisterableEvent({ registrationMode: "closed" });
    await setEvent(event.id, { waitlistEnabled: true });
    const { cookie } = await loginAs("student");
    const res = await joinWaitlist(event.id, cookie);
    expect(res.status).toBe(403);
  });

  it("waitlist disabled → 400 waitlist_disabled", async () => {
    const event = await makeRegisterableEvent(); // waitlistEnabled defaults false
    const { cookie } = await loginAs("student");
    const res = await joinWaitlist(event.id, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "waitlist_disabled" });
  });

  it("registration window closed → 400 registration_closed", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000);
    const event = await makeRegisterableEvent({ registrationCloseAt: past });
    await setEvent(event.id, { waitlistEnabled: true });
    const { cookie } = await loginAs("student");
    const res = await joinWaitlist(event.id, cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "registration_closed" });
  });

  it("already has an active (registered) reg → 200 idempotent, returns existing row", async () => {
    const event = await makeRegisterableEvent({ capacity: 5 });
    await setEvent(event.id, { waitlistEnabled: true });
    const { cookie } = await loginAs("student");
    // First register normally (status registered).
    const r1 = await submitRegister(event.id, cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    const res = await joinWaitlist(event.id, cookie);
    expect(res.status).toBe(200); // alreadyExisted → 200, not a new row
    const body = (await res.json()) as { registration: { id: string; status: string } };
    expect(body.registration.id).toBe(regId);
    expect(body.registration.status).toBe("registered"); // existing status untouched
    // Still exactly one row for this event.
    const rows = await db.select().from(registrations).where(eq(registrations.eventId, event.id));
    expect(rows.length).toBe(1);
  });

  it("cancelled student joins waitlist → existing row REACTIVATED as waitlisted (still one row)", async () => {
    const event = await makeRegisterableEvent();
    await setEvent(event.id, { waitlistEnabled: true, allowStudentCancelRegistration: true });
    const { cookie } = await loginAs("student");
    // Register, then cancel → leaves a cancelled row.
    const r1 = await submitRegister(event.id, cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;
    await request(`/registrations/${regId}/cancel`, { method: "POST", cookie });

    const res = await joinWaitlist(event.id, cookie);
    expect(res.status).toBe(201); // reactivation path → 201
    const body = (await res.json()) as { registration: { id: string; status: string } };
    expect(body.registration.id).toBe(regId); // same row reactivated, not duplicated
    expect(body.registration.status).toBe("waitlisted");

    const rows = await db.select().from(registrations).where(eq(registrations.eventId, event.id));
    expect(rows.length).toBe(1);
  });

  it("unauthenticated → 401", async () => {
    const event = await makeRegisterableEvent();
    await setEvent(event.id, { waitlistEnabled: true });
    const res = await joinWaitlist(event.id); // no cookie
    expect(res.status).toBe(401);
  });
});

// =====================================================================
// POST /admin/registrations/:id/promote (waitlisted → registered, issues QR)
// =====================================================================

describe("registrations: admin promote", () => {
  function promote(id: string, cookie: string, body: Record<string, unknown> = { reason: "spot opened" }) {
    return request(`/admin/registrations/${id}/promote`, { method: "POST", cookie, body });
  }

  it("waitlisted → registered + QR issued-on-promote", async () => {
    const admin = await loginAs("admin");
    const reg = await makeRegistration({ status: "waitlisted" });
    // No active token before promote.
    expect((await activeQrRows(reg.id)).length).toBe(0);

    const res = await promote(reg.id, admin.cookie);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; qrToken: string };
    expect(body.ok).toBe(true);
    expect(body.qrToken).toBeTruthy(); // plaintext returned once

    const after = (await getReg(reg.id))!;
    expect(after.status).toBe("registered");
    expect(after.registeredAt).not.toBeNull();
    // Exactly one active QR row appeared; stored as hash of the returned plaintext.
    const active = await activeQrRows(reg.id);
    expect(active.length).toBe(1);
    expect(active[0]!.tokenHash).toBe(hashToken(body.qrToken));
  });

  it("non-waitlisted (registered) → 400 not_waitlisted", async () => {
    const admin = await loginAs("admin");
    const reg = await makeRegistration({ status: "registered" });
    const res = await promote(reg.id, admin.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_waitlisted" });
  });

  it("promote past a full capacity still succeeds (admin override has no capacity gate)", async () => {
    // capacity=1, already filled by an active reg; a waitlisted one promotes past the limit.
    const event = await makeRegisterableEvent({ capacity: 1 });
    await makeRegistration({ event, status: "registered" }); // fills the one slot
    const waiter = await makeRegistration({ event, status: "waitlisted" });
    const admin = await loginAs("admin");

    const res = await promote(waiter.id, admin.cookie);
    expect(res.status).toBe(200); // promote does not check capacity
    expect((await getReg(waiter.id))!.status).toBe("registered");
  });

  it("reason required → 400", async () => {
    const admin = await loginAs("admin");
    const reg = await makeRegistration({ status: "waitlisted" });
    const res = await promote(reg.id, admin.cookie, {}); // missing reason → Zod 400
    expect(res.status).toBe(400);
  });

  it("non-admin (student) → 403", async () => {
    const student = await loginAs("student");
    const reg = await makeRegistration({ status: "waitlisted" });
    const res = await promote(reg.id, student.cookie);
    expect(res.status).toBe(403);
  });
});

// =====================================================================
// POST /admin/registrations/:id/demote (registered → waitlisted, revokes QR)
// =====================================================================

describe("registrations: admin demote", () => {
  function demote(id: string, cookie: string, body: Record<string, unknown> = { reason: "rebalance" }) {
    return request(`/admin/registrations/${id}/demote`, { method: "POST", cookie, body });
  }

  it("registered → waitlisted + active QR revoked-on-demote", async () => {
    // Self-register a student so a REAL active QR exists, then demote.
    const event = await makeRegisterableEvent();
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;
    expect((await activeQrRows(regId)).length).toBe(1); // QR present while registered

    const admin = await loginAs("admin");
    const res = await demote(regId, admin.cookie);
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    const after = (await getReg(regId))!;
    expect(after.status).toBe("waitlisted");
    expect(after.waitlistedAt).not.toBeNull();
    // Active token gone (revoked); the row persists but is no longer active.
    expect((await activeQrRows(regId)).length).toBe(0);
  });

  it("non-registered (waitlisted) → 400 not_registered", async () => {
    const admin = await loginAs("admin");
    const reg = await makeRegistration({ status: "waitlisted" });
    const res = await demote(reg.id, admin.cookie);
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_registered" });
  });

  it("reason required → 400", async () => {
    const admin = await loginAs("admin");
    const reg = await makeRegistration({ status: "registered" });
    const res = await demote(reg.id, admin.cookie, {});
    expect(res.status).toBe(400);
  });

  it("non-admin (student) → 403", async () => {
    const student = await loginAs("student");
    const reg = await makeRegistration({ status: "registered" });
    const res = await demote(reg.id, student.cookie);
    expect(res.status).toBe(403);
  });
});

// =====================================================================
// PATCH /registrations/:id/answers (student self-edit)
// =====================================================================

describe("registrations: student self-edit answers", () => {
  // Seed a one-field schema so we can assert the answer actually rewrites.
  async function makeEditableEvent(opts: Parameters<typeof makeEvent>[0] = {}) {
    const event = await makeEvent(opts);
    await db.insert(eventFormVersions).values({
      eventId: event.id,
      versionNumber: 1,
      schemaJson: { fields: [{ key: "name", type: "short_text", label: "Name", required: true, sort: 0 }] },
      createdByAdminId: event.createdByAdminId,
      isActive: true,
    });
    await setEvent(event.id, { allowStudentEditRegistration: true });
    return event;
  }

  function editAnswers(regId: string, cookie: string, answers: Record<string, unknown>) {
    return request(`/registrations/${regId}/answers`, { method: "PATCH", cookie, body: { answers } });
  }

  it("editing allowed → 200, answer rewritten", async () => {
    const event = await makeEditableEvent();
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie, { name: "Before" });
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    const res = await editAnswers(regId, student.cookie, { name: "After" });
    expect(res.status).toBe(200);
    expect((await res.json()) as { ok: boolean }).toEqual({ ok: true });

    // Round-trip the change via the owner detail endpoint.
    const detail = await request(`/me/registrations/${regId}`, { cookie: student.cookie });
    const body = (await detail.json()) as { answers: Record<string, unknown> };
    expect(body.answers.name).toBe("After");
  });

  it("event disallows student edit → 403", async () => {
    const event = await makeEditableEvent();
    await setEvent(event.id, { allowStudentEditRegistration: false });
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie, { name: "X" });
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    const res = await editAnswers(regId, student.cookie, { name: "Y" });
    expect(res.status).toBe(403);
  });

  it("past edit deadline → 400 edit_closed", async () => {
    const event = await makeEditableEvent();
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie, { name: "X" });
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;
    // Close the edit window in the past.
    await setEvent(event.id, { editRegistrationCloseAt: new Date(Date.now() - 60 * 60 * 1000) });

    const res = await editAnswers(regId, student.cookie, { name: "Y" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "edit_closed" });
  });

  it("already checked_in → 400 already_checked_in", async () => {
    const event = await makeEditableEvent();
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie, { name: "X" });
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;
    // Force checked_in directly (skip the scan ladder; we only test the edit guard).
    await db.update(registrations).set({ status: "checked_in" }).where(eq(registrations.id, regId));

    const res = await editAnswers(regId, student.cookie, { name: "Y" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "already_checked_in" });
  });

  it("cancelled registration → 400 cancelled", async () => {
    const event = await makeEditableEvent();
    await setEvent(event.id, { allowStudentCancelRegistration: true });
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie, { name: "X" });
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;
    await request(`/registrations/${regId}/cancel`, { method: "POST", cookie: student.cookie });

    const res = await editAnswers(regId, student.cookie, { name: "Y" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "cancelled" });
  });

  it("editing someone else's registration → 403", async () => {
    const event = await makeEditableEvent();
    const owner = await loginAs("student");
    const r1 = await submitRegister(event.id, owner.cookie, { name: "X" });
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    const attacker = await loginAs("student");
    const res = await editAnswers(regId, attacker.cookie, { name: "hacked" });
    expect(res.status).toBe(403);
  });
});

// =====================================================================
// GET /me/registrations/:id (owner detail + QR display payload)
// =====================================================================

describe("registrations: owner detail + QR display", () => {
  it("owner gets back a usable decrypted QR token + phase/eligibility fields", async () => {
    const event = await makeRegisterableEvent();
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie);
    const r1body = (await r1.json()) as { registration: { id: string }; qrToken: string };
    const issuedToken = r1body.qrToken;
    const regId = r1body.registration.id;

    const res = await request(`/me/registrations/${regId}`, { cookie: student.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      registration: { id: string; status: string };
      qr: { eligible: boolean; available: boolean; token: string | null; phase: string; showQr: boolean };
    };
    expect(body.registration.id).toBe(regId);
    expect(body.qr.eligible).toBe(true);
    expect(body.qr.available).toBe(true);
    // getActiveQrTokenForOwner round-trip: the decrypted token equals the plaintext issued at register.
    expect(body.qr.token).toBe(issuedToken);
    // Pre-check-in on a published event with open (null) check-in window → checkin phase, QR shown.
    expect(body.qr.phase).toBe("checkin");
    expect(body.qr.showQr).toBe(true);
  });

  it("another student fetching this reg → 403 (ownership enforced)", async () => {
    const event = await makeRegisterableEvent();
    const owner = await loginAs("student");
    const r1 = await submitRegister(event.id, owner.cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;

    const attacker = await loginAs("student");
    const res = await request(`/me/registrations/${regId}`, { cookie: attacker.cookie });
    expect(res.status).toBe(403);
  });

  it("legacy null-token fallback: active token with no tokenEnc → eligible but token null, not available", async () => {
    const event = await makeRegisterableEvent();
    const student = await loginAs("student");
    const r1 = await submitRegister(event.id, student.cookie);
    const regId = ((await r1.json()) as { registration: { id: string } }).registration.id;
    // Simulate a pre-redisplay legacy row: null out tokenEnc on the active token.
    await db
      .update(registrationQrTokens)
      .set({ tokenEnc: null })
      .where(
        and(eq(registrationQrTokens.registrationId, regId), eq(registrationQrTokens.status, "active")),
      );

    const res = await request(`/me/registrations/${regId}`, { cookie: student.cookie });
    const body = (await res.json()) as { qr: { eligible: boolean; available: boolean; token: string | null } };
    expect(body.qr.eligible).toBe(true); // status/event still eligible
    expect(body.qr.token).toBeNull(); // no tokenEnc → cannot decrypt → null
    expect(body.qr.available).toBe(false); // available = eligible && token != null
  });
});
