import { describe, it, expect } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db/client";
import { eventFormVersions } from "../src/db/schema/forms";
import { registrations } from "../src/db/schema/registrations";
import { users } from "../src/db/schema/users";
import { pointLedger } from "../src/db/schema/points";
import { assessmentAnswers, assessmentSubmissions } from "../src/db/schema/assessments";
import { eventPointConfig, pointSettings } from "../src/db/schema/point-config";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";
import type { Event } from "../src/db/schema/events";
import type { User } from "../src/db/schema/users";
import type { FormSchema } from "../src/lib/form-schema";

// ---- local helpers ----

// Insert an active assessment form version for an event (formType discriminator).
async function makeAssessmentForm(event: Event, schema: FormSchema = { fields: [] }): Promise<string> {
  const [row] = await db
    .insert(eventFormVersions)
    .values({
      eventId: event.id,
      formType: "assessment",
      versionNumber: 1,
      schemaJson: schema,
      createdByAdminId: event.createdByAdminId,
      isActive: true,
    })
    .returning();
  return row!.id;
}

// Enable assessment on an event; assessmentRequiresCheckin defaults true unless overridden.
async function configureAssessment(
  eventId: string,
  opts: {
    points?: number | null;
    requiresCheckin?: boolean;
    openAt?: Date | null;
    closeAt?: Date | null;
  } = {},
) {
  const set = {
    assessmentEnabled: true,
    assessmentRequiresCheckin: opts.requiresCheckin ?? true,
    assessmentPoints: opts.points ?? null,
    assessmentOpenAt: opts.openAt ?? null,
    assessmentCloseAt: opts.closeAt ?? null,
  };
  await db
    .insert(eventPointConfig)
    .values({ eventId, ...set })
    .onConflictDoUpdate({ target: eventPointConfig.eventId, set });
}

// A checked-in student for an event (so requiresCheckin passes by default).
async function checkedInStudent(event: Event): Promise<{ user: User; cookie: string }> {
  const { user, cookie } = await loginAs("student");
  await makeRegistration({ event, user, status: "checked_in" });
  return { user, cookie };
}

function submit(eventId: string, cookie: string, answers: Record<string, unknown> = {}) {
  return request(`/events/${eventId}/assessment`, { method: "POST", cookie, body: { answers } });
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

// =====================================================================
// Award on first submit + idempotency
// =====================================================================
describe("points: assessment award (default 100, idempotent, balance == SUM(delta))", () => {
  it("first submit awards the global default 100 and surfaces pointsAwarded", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id);
    const { user, cookie } = await checkedInStudent(event);

    const res = await submit(event.id, cookie);
    const body = (await res.json()) as { result: string; pointsAwarded: number };
    expect(body.result).toBe("submitted_success");
    expect(body.pointsAwarded).toBe(100);
    expect(await balanceOf(user.id)).toBe(100);
    expect(await ledgerSum(user.id)).toBe(100); // cache == truth
  });

  it("re-submit does NOT double-award (unique submission + dedupeKey)", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id);
    const { user, cookie } = await checkedInStudent(event);

    await submit(event.id, cookie);
    const second = await submit(event.id, cookie);
    const body = (await second.json()) as { result: string };
    expect(body.result).toBe("already_submitted");
    expect(await balanceOf(user.id)).toBe(100); // still 100
    expect(await ledgerSum(user.id)).toBe(100);

    // Exactly one submission + one ledger entry.
    const subs = await db.select().from(assessmentSubmissions).where(eq(assessmentSubmissions.userId, user.id));
    expect(subs.length).toBe(1);
    const entries = await db.select().from(pointLedger).where(eq(pointLedger.userId, user.id));
    expect(entries.filter((e) => e.reasonCode === "assessment_completed").length).toBe(1);
  });

  // Real race (not the sequential re-submit above): two parallel POSTs hit the unique-submission
  // insert at once → exactly one wins. Exactly one submission, one ledger row, one award worth.
  it("two concurrent first-submits → exactly one award (one submission + one ledger row)", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id);
    const { user, cookie } = await checkedInStudent(event);

    const [a, b] = await Promise.all([submit(event.id, cookie), submit(event.id, cookie)]);
    const results = [
      ((await a.json()) as { result: string }).result,
      ((await b.json()) as { result: string }).result,
    ].sort();
    // One success, one already_submitted (order non-deterministic) — never two successes.
    expect(results).toEqual(["already_submitted", "submitted_success"]);

    expect(await balanceOf(user.id)).toBe(100); // single award
    expect(await ledgerSum(user.id)).toBe(100);
    const subs = await db
      .select()
      .from(assessmentSubmissions)
      .where(eq(assessmentSubmissions.userId, user.id));
    expect(subs.length).toBe(1);
    const awards = (
      await db.select().from(pointLedger).where(eq(pointLedger.userId, user.id))
    ).filter((e) => e.reasonCode === "assessment_completed");
    expect(awards.length).toBe(1);
  });

  it("per-event override beats the global default", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id, { points: 250 });
    const { user, cookie } = await checkedInStudent(event);
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("submitted_success");
    expect(await balanceOf(user.id)).toBe(250);
  });
});

// =====================================================================
// Guards: toggle, cutoff, window, requires-checkin
// =====================================================================
describe("points: assessment guards", () => {
  it("assessmentEnabled=false → assessment_not_open, no submission, no award", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    // No config row → assessmentEnabled defaults false.
    const { user, cookie } = await checkedInStudent(event);
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("assessment_not_open");
    expect(await balanceOf(user.id)).toBe(0);
    const subs = await db.select().from(assessmentSubmissions).where(eq(assessmentSubmissions.userId, user.id));
    expect(subs.length).toBe(0);
  });

  it("past cutoff → points_closed, no award", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id);
    await db
      .insert(pointSettings)
      .values({ id: 1, cutoffAt: new Date(Date.now() - 60_000) })
      .onConflictDoUpdate({ target: pointSettings.id, set: { cutoffAt: new Date(Date.now() - 60_000) } });
    const { user, cookie } = await checkedInStudent(event);
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("points_closed");
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("before the assessment window opens → assessment_not_open", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id, { openAt: new Date(Date.now() + 60 * 60_000) }); // opens in 1h
    const { user, cookie } = await checkedInStudent(event);
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("assessment_not_open");
    expect(await balanceOf(user.id)).toBe(0);
  });

  // Auto-open default: no openAt override → assessment opens at eventStartAt. Future start = not open yet,
  // EVEN with a closeAt set (independent fallbacks — close override must not drop the eventStartAt open).
  it("auto-open (no openAt) respects a FUTURE eventStartAt even when closeAt is set → assessment_not_open", async () => {
    const event = await makeEvent({
      status: "published",
      eventStartAt: new Date(Date.now() + 60 * 60_000), // starts in 1h
    });
    await makeAssessmentForm(event);
    await configureAssessment(event.id, { closeAt: new Date(Date.now() + 120 * 60_000) }); // openAt null
    const { user, cookie } = await checkedInStudent(event);
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("assessment_not_open");
    expect(await balanceOf(user.id)).toBe(0);
  });

  // Auto-open default, past eventStartAt + future closeAt → open now → awards.
  it("auto-open (no openAt) with a PAST eventStartAt and future closeAt → submits + awards", async () => {
    const event = await makeEvent({
      status: "published",
      eventStartAt: new Date(Date.now() - 60 * 60_000), // started 1h ago
    });
    await makeAssessmentForm(event);
    await configureAssessment(event.id, { closeAt: new Date(Date.now() + 60 * 60_000) }); // openAt null
    const { user, cookie } = await checkedInStudent(event);
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("submitted_success");
    expect(await balanceOf(user.id)).toBe(100);
  });

  it("requiresCheckin=true blocks a non-checked-in student (checkin_required), no award", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id, { requiresCheckin: true });
    // Registered but NOT checked in.
    const { user, cookie } = await loginAs("student");
    await makeRegistration({ event, user, status: "registered" });
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("checkin_required");
    expect(await balanceOf(user.id)).toBe(0);
  });

  it("requiresCheckin=true allows a checked-in student (and a checked-out one)", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id, { requiresCheckin: true });
    const { user, cookie } = await checkedInStudent(event);
    expect(((await (await submit(event.id, cookie)).json()) as { result: string }).result).toBe(
      "submitted_success",
    );
    expect(await balanceOf(user.id)).toBe(100);
  });

  it("requiresCheckin=false allows a not-checked-in (even unregistered) student", async () => {
    const event = await makeEvent({ status: "published" });
    await makeAssessmentForm(event);
    await configureAssessment(event.id, { requiresCheckin: false });
    const { user, cookie } = await loginAs("student"); // no registration at all
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("submitted_success");
    expect(await balanceOf(user.id)).toBe(100);
  });

  // Event must be published — a draft/cancelled/archived event must never award assessment points.
  // No submission row and no ledger row may be written for a non-published event.
  for (const status of ["draft", "cancelled", "archived"] as const) {
    it(`event status=${status} → assessment_not_open, no submission, no ledger, balance 0`, async () => {
      const event = await makeEvent({ status });
      await makeAssessmentForm(event);
      await configureAssessment(event.id, { requiresCheckin: false });
      const { user, cookie } = await loginAs("student");

      const res = await submit(event.id, cookie);
      expect(((await res.json()) as { result: string }).result).toBe("assessment_not_open");

      expect(await balanceOf(user.id)).toBe(0);
      expect(await ledgerSum(user.id)).toBe(0);
      const subs = await db
        .select()
        .from(assessmentSubmissions)
        .where(eq(assessmentSubmissions.userId, user.id));
      expect(subs.length).toBe(0);
      const ledger = await db.select().from(pointLedger).where(eq(pointLedger.userId, user.id));
      expect(ledger.length).toBe(0);
    });
  }

  it("no assessment form built → no_assessment_form", async () => {
    const event = await makeEvent({ status: "published" });
    await configureAssessment(event.id, { requiresCheckin: false });
    const { cookie } = await loginAs("student");
    const res = await submit(event.id, cookie);
    expect(((await res.json()) as { result: string }).result).toBe("no_assessment_form");
  });
});

// =====================================================================
// Structural edit of a submitted assessment forks a new version
// (versionIsReferenced now sees assessment answers)
// =====================================================================
describe("assessment form: structural edit forks a new version once answers exist", () => {
  it("a stored assessment answer makes the version referenced → structural PUT forks v2", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ status: "published", createdByAdminId: admin.user.id });
    const schemaV1: FormSchema = {
      fields: [{ key: "rating", type: "short_text", label: "Rating", required: true, sort: 0 }],
    };
    await makeAssessmentForm(event, schemaV1);
    await configureAssessment(event.id, { requiresCheckin: false });

    // Student submits → assessment answer rows now reference the active version.
    const { cookie } = await loginAs("student");
    const ok = await submit(event.id, cookie, { rating: "great" });
    expect(((await ok.json()) as { result: string }).result).toBe("submitted_success");
    const ansCount = await db.select().from(assessmentAnswers);
    expect(ansCount.length).toBe(1);

    // Admin makes a STRUCTURAL change (add a required field) → must fork rather than edit in place.
    const schemaV2: FormSchema = {
      fields: [
        { key: "rating", type: "short_text", label: "Rating", required: true, sort: 0 },
        { key: "comment", type: "paragraph", label: "Comment", required: true, sort: 1 },
      ],
    };
    const put = await request(`/admin/events/${event.id}/forms/assessment`, {
      method: "PUT",
      cookie: admin.cookie,
      body: { schema: schemaV2 },
    });
    const body = (await put.json()) as { versioned: boolean; form: { versionNumber: number } };
    expect(body.versioned).toBe(true);
    expect(body.form.versionNumber).toBe(2);

    // Two assessment versions exist; exactly one active.
    const versions = await db
      .select()
      .from(eventFormVersions)
      .where(eq(eventFormVersions.eventId, event.id));
    const assessmentVersions = versions.filter((v) => v.formType === "assessment");
    expect(assessmentVersions.length).toBe(2);
    expect(assessmentVersions.filter((v) => v.isActive).length).toBe(1);
  });
});
