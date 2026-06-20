import { describe, it, expect } from "vitest";
import { db } from "../src/db/client";
import { events as eventsTable } from "../src/db/schema/events";
import { eventFormVersions } from "../src/db/schema/forms";
import { eq } from "drizzle-orm";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent } from "./helpers/factories";

// ---------------------------------------------------------------------------
// Events + Forms backend integration suite. Built on the tier-1 harness.
//
// NOTE on "soft-delete": the events table has NO `deleted_at` column and there
// is NO DELETE route (see grep of src/modules/events). In V1 the soft-delete
// invariant for events is realized via the `archived` (and `cancelled`) STATUS
// — the row always persists, never hard-deleted, and `archived` drops out of
// public listings. These tests assert that real mechanism. See REPORT.
// ---------------------------------------------------------------------------

// Create an event through the REAL admin POST route (returns the created row + cookie of owner).
async function createEventViaApi(
  cookie: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return request("/admin/events", { method: "POST", cookie, body });
}

// Move an event's status via the real status route.
function changeStatus(eventId: string, cookie: string, status: string, reason?: string) {
  return request(`/admin/events/${eventId}/status`, {
    method: "POST",
    cookie,
    body: reason ? { status, reason } : { status },
  });
}

// Pull the raw event row straight from DB (to assert persistence / no hard delete).
async function eventRow(id: string) {
  const [row] = await db.select().from(eventsTable).where(eq(eventsTable.id, id)).limit(1);
  return row;
}

// ===========================================================================
// 1. Slug uniqueness + public lookup resolution
// ===========================================================================
describe("events: slug uniqueness + public lookup", () => {
  it("creates an event with an explicit unique slug", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, { title: "Orientation", publicSlug: "orientation-2026" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { event: { publicSlug: string; status: string } };
    expect(body.event.publicSlug).toBe("orientation-2026");
    expect(body.event.status).toBe("draft"); // always created as draft
  });

  // FINDING: duplicate slug is NOT rejected with 4xx — ensureUniqueSlug() silently
  // disambiguates by appending -2/-3. So the contract is "slug stays unique", not
  // "duplicate request fails". We assert the real (auto-disambiguate) behavior.
  it("duplicate slug is auto-disambiguated (-2), never collides", async () => {
    const admin = await loginAs("admin");
    const first = await createEventViaApi(admin.cookie, { title: "A", publicSlug: "dup-slug" });
    const second = await createEventViaApi(admin.cookie, { title: "B", publicSlug: "dup-slug" });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201); // not rejected — disambiguated instead
    const s1 = ((await first.json()) as { event: { publicSlug: string } }).event.publicSlug;
    const s2 = ((await second.json()) as { event: { publicSlug: string } }).event.publicSlug;
    expect(s1).toBe("dup-slug");
    expect(s2).toBe("dup-slug-2"); // unique invariant preserved by suffixing
    expect(s1).not.toBe(s2);
  });

  it("slug auto-derived from title when none supplied", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, { title: "Welcome Day!" });
    const slug = ((await res.json()) as { event: { publicSlug: string } }).event.publicSlug;
    expect(slug).toBe("welcome-day"); // slugify drops punctuation
  });

  it("GET /events/:slug resolves the right published event", async () => {
    const event = await makeEvent({ status: "published", visibility: "listed", publicSlug: "find-me" });
    const res = await request(`/events/find-me`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { id: string; publicSlug: string } };
    expect(body.event.id).toBe(event.id);
    expect(body.event.publicSlug).toBe("find-me");
  });

  it("GET /e/:publicId redirects (302) to the current pretty slug", async () => {
    const event = await makeEvent({ status: "published", publicSlug: "qr-target" });
    const res = await request(`/e/${event.publicId}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/events/qr-target`);
  });

  it("draft event is NOT exposed via public slug → 404", async () => {
    await makeEvent({ status: "draft", publicSlug: "secret-draft" });
    const res = await request(`/events/secret-draft`);
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "not_found" });
  });

  it("draft event is NOT exposed via /e/:publicId → 404", async () => {
    const event = await makeEvent({ status: "draft" });
    const res = await request(`/e/${event.publicId}`);
    expect(res.status).toBe(404);
  });

  it("unknown slug → 404", async () => {
    const res = await request(`/events/does-not-exist`);
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 2. "Soft-delete" via archived status + no hard delete
// ===========================================================================
describe("events: archived (soft) status + no hard delete", () => {
  // archived row must persist (no hard delete anywhere) and disappear from public listing.
  it("archiving an event keeps the row but removes it from public listing", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      status: "published",
      visibility: "listed",
      publicSlug: "to-archive",
    });

    // Visible in public list while published.
    const before = (await (await request("/events")).json()) as { events: { id: string }[] };
    expect(before.events.some((e) => e.id === event.id)).toBe(true);

    const res = await changeStatus(event.id, admin.cookie, "archived", "end of season");
    expect(res.status).toBe(200);

    // Row still exists (no hard delete).
    const row = await eventRow(event.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe("archived");

    // Gone from public listing.
    const after = (await (await request("/events")).json()) as { events: { id: string }[] };
    expect(after.events.some((e) => e.id === event.id)).toBe(false);
  });

  it("archived event still 404s on the public detail page is NOT true — archived is public read-only", async () => {
    // archived is NOT draft, so GET /events/:slug returns it (read-only). Only draft → 404.
    const event = await makeEvent({ status: "archived", publicSlug: "archived-page" });
    const res = await request(`/events/archived-page`);
    expect(res.status).toBe(200); // archived is served (status field signals read-only to client)
    const body = (await res.json()) as { event: { status: string } };
    expect(body.event.status).toBe("archived");
  });

  it("admin detail still returns an archived event (row never destroyed)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "archived" });
    const res = await request(`/admin/events/${event.id}`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { id: string; status: string } };
    expect(body.event.id).toBe(event.id);
    expect(body.event.status).toBe("archived");
  });
});

// ===========================================================================
// 3. Lifecycle / status transitions + visibility in public listing
// ===========================================================================
describe("events: status transitions", () => {
  it("draft → published makes the event publicly visible", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      status: "draft",
      visibility: "listed",
      publicSlug: "go-live",
    });

    // Not in public list while draft.
    const before = (await (await request("/events")).json()) as { events: { id: string }[] };
    expect(before.events.some((e) => e.id === event.id)).toBe(false);

    const res = await changeStatus(event.id, admin.cookie, "published");
    expect(res.status).toBe(200);
    expect(((await res.json()) as { event: { status: string } }).event.status).toBe("published");

    const after = (await (await request("/events")).json()) as { events: { id: string }[] };
    expect(after.events.some((e) => e.id === event.id)).toBe(true);
  });

  it("published → cancelled keeps event listed publicly (with cancelled status)", async () => {
    // Public list intentionally includes published + cancelled (cancelled shows a 'cancelled' flag).
    const admin = await loginAs("admin");
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      status: "published",
      visibility: "listed",
      publicSlug: "cancel-me",
    });
    const res = await changeStatus(event.id, admin.cookie, "cancelled", "venue lost");
    expect(res.status).toBe(200);

    const list = (await (await request("/events")).json()) as { events: { id: string; status: string }[] };
    const found = list.events.find((e) => e.id === event.id);
    expect(found).toBeDefined();
    expect(found?.status).toBe("cancelled");
  });

  it("same-status status change is a no-op 200 (nothing to audit)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "published" });
    const res = await changeStatus(event.id, admin.cookie, "published");
    expect(res.status).toBe(200);
  });

  // FINDING: there is NO state-machine guard. ANY enum status → ANY other is accepted
  // (e.g. archived → draft, cancelled → published). The brief's "invalid transitions
  // rejected" invariant is NOT enforced in src. We assert the REAL permissive behavior
  // and surface it in the report — we do NOT modify src.
  it("backwards transition archived → draft is ACCEPTED (no transition guard in src)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, status: "archived" });
    const res = await changeStatus(event.id, admin.cookie, "draft");
    expect(res.status).toBe(200); // permissive — documented finding
    expect((await eventRow(event.id))?.status).toBe("draft");
  });

  it("invalid status value → 400 validation_error (enum rejects it)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await changeStatus(event.id, admin.cookie, "closed"); // 'closed' is not a status enum
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "validation_error" });
  });

  it("status change on unknown event → 404", async () => {
    const admin = await loginAs("admin");
    const res = await changeStatus("00000000-0000-0000-0000-000000000000", admin.cookie, "published");
    expect(res.status).toBe(404);
  });
});

describe("events: visibility honored in public listing", () => {
  it("unlisted published event is hidden from GET /events but reachable by direct slug", async () => {
    const event = await makeEvent({
      status: "published",
      visibility: "unlisted",
      publicSlug: "unlisted-evt",
    });

    const list = (await (await request("/events")).json()) as { events: { id: string }[] };
    expect(list.events.some((e) => e.id === event.id)).toBe(false); // not in listing

    // Direct slug still resolves (unlisted = "not listed", not "private").
    const direct = await request(`/events/unlisted-evt`);
    expect(direct.status).toBe(200);
  });

  it("listed published event appears in GET /events", async () => {
    const event = await makeEvent({ status: "published", visibility: "listed" });
    const list = (await (await request("/events")).json()) as { events: { id: string }[] };
    expect(list.events.some((e) => e.id === event.id)).toBe(true);
  });

  it("POST visibility change to unlisted removes it from the public list", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      status: "published",
      visibility: "listed",
      publicSlug: "hide-me",
    });
    const res = await request(`/admin/events/${event.id}/visibility`, {
      method: "POST",
      cookie: admin.cookie,
      body: { visibility: "unlisted", reason: "internal only" },
    });
    expect(res.status).toBe(200);
    const list = (await (await request("/events")).json()) as { events: { id: string }[] };
    expect(list.events.some((e) => e.id === event.id)).toBe(false);
  });
});

// ===========================================================================
// 4. Create / edit validation (Zod boundary)
// ===========================================================================
describe("events: create/edit validation", () => {
  it("missing title → 400 validation_error", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, { description: "no title" });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "validation_error" });
  });

  it("empty title → 400 (min length 1)", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, { title: "" });
    expect(res.status).toBe(400);
  });

  it("capacity_enabled without capacity_limit → 400 capacity_limit_required", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, { title: "Cap", capacityEnabled: true });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "capacity_limit_required" });
  });

  it("capacity_enabled WITH a positive limit → 201", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, {
      title: "Cap OK",
      capacityEnabled: true,
      capacityLimit: 50,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { event: { capacityLimit: number } }).event.capacityLimit).toBe(50);
  });

  it("non-positive capacity_limit → 400 (zod int positive)", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, {
      title: "Bad Cap",
      capacityEnabled: true,
      capacityLimit: 0,
    });
    expect(res.status).toBe(400);
  });

  it("ISO-8601 window strings are coerced to dates and stored as timestamptz", async () => {
    const admin = await loginAs("admin");
    const open = "2026-07-01T00:00:00.000Z";
    const close = "2026-07-10T00:00:00.000Z";
    const res = await createEventViaApi(admin.cookie, {
      title: "Windowed",
      registrationOpenAt: open,
      registrationCloseAt: close,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      event: { id: string; registrationOpenAt: string; registrationCloseAt: string };
    };
    // Round-trips back to the same UTC instant.
    expect(new Date(body.event.registrationOpenAt).toISOString()).toBe(open);
    expect(new Date(body.event.registrationCloseAt).toISOString()).toBe(close);
  });

  // Window ordering is now enforced at the API boundary (full-hardening: validateEventTiming).
  // A close-before-open window is rejected with invalid_timing (was previously accepted — gap closed).
  it("registration close BEFORE open is REJECTED (end-after-start guard)", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, {
      title: "Inverted Window",
      registrationOpenAt: "2026-07-10T00:00:00.000Z",
      registrationCloseAt: "2026-07-01T00:00:00.000Z", // before open
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("unknown field on PATCH → 400 (updateEventSchema is .strict())", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await request(`/admin/events/${event.id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { title: "Edited", bogusField: "x" },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "validation_error" });
  });

  it("PATCH a valid title → 200 and persists", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, title: "Old" });
    const res = await request(`/admin/events/${event.id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { title: "New Title" },
    });
    expect(res.status).toBe(200);
    expect((await eventRow(event.id))?.title).toBe("New Title");
  });

  it("PATCH unknown event → 404", async () => {
    const admin = await loginAs("admin");
    const res = await request(`/admin/events/00000000-0000-0000-0000-000000000000`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { title: "x" },
    });
    expect(res.status).toBe(404);
  });
});

// ===========================================================================
// 5. Dynamic form schema lifecycle + schema validation
// ===========================================================================
describe("forms: version lifecycle", () => {
  // PATCH with no active version bootstraps version 1.
  it("PATCH /form with no active version → bootstraps version 1 (versioned:true)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await request(`/admin/events/${event.id}/form`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { schema: { fields: [{ key: "name", type: "short_text", label: "Name", required: true, sort: 0 }] } },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { form: { versionNumber: number; isActive: boolean }; versioned: boolean };
    expect(body.versioned).toBe(true);
    expect(body.form.versionNumber).toBe(1);
    expect(body.form.isActive).toBe(true);
  });

  it("GET /form returns the active version after creation", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    await request(`/admin/events/${event.id}/form`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { schema: { fields: [] } },
    });
    const res = await request(`/admin/events/${event.id}/form`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { form: { versionNumber: number; isActive: boolean } | null };
    expect(body.form?.isActive).toBe(true);
    expect(body.form?.versionNumber).toBe(1);
  });

  it("POST /form/version always creates a NEW active version and deactivates the prior one", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    // Bootstrap v1.
    await request(`/admin/events/${event.id}/form`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { schema: { fields: [] } },
    });
    // Explicit new version v2.
    const res = await request(`/admin/events/${event.id}/form/version`, {
      method: "POST",
      cookie: admin.cookie,
      body: { schema: { fields: [{ key: "q", type: "short_text", label: "Q", sort: 0 }] }, reason: "new q" },
    });
    expect(res.status).toBe(201);
    const v2 = (await res.json()) as { form: { id: string; versionNumber: number; isActive: boolean } };
    expect(v2.form.versionNumber).toBe(2);
    expect(v2.form.isActive).toBe(true);

    // Exactly one active version remains (the partial-unique index enforces this; assert via DB).
    const rows = await db
      .select()
      .from(eventFormVersions)
      .where(eq(eventFormVersions.eventId, event.id));
    expect(rows.length).toBe(2);
    expect(rows.filter((r) => r.isActive).length).toBe(1);
    expect(rows.find((r) => r.isActive)?.versionNumber).toBe(2); // v2 is now active
  });

  it("GET /form/versions lists all versions newest-first", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    await request(`/admin/events/${event.id}/form`, {
      method: "PATCH", cookie: admin.cookie, body: { schema: { fields: [] } },
    });
    await request(`/admin/events/${event.id}/form/version`, {
      method: "POST", cookie: admin.cookie, body: { schema: { fields: [] } },
    });
    const res = await request(`/admin/events/${event.id}/form/versions`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { versions: { versionNumber: number; isActive: boolean }[] };
    expect(body.versions.map((v) => v.versionNumber)).toEqual([2, 1]); // desc
    expect(body.versions.find((v) => v.versionNumber === 2)?.isActive).toBe(true);
  });

  it("form ops on unknown event → 404", async () => {
    const admin = await loginAs("admin");
    const res = await request(`/admin/events/00000000-0000-0000-0000-000000000000/form/versions`, {
      cookie: admin.cookie,
    });
    expect(res.status).toBe(404);
  });
});

describe("forms: schema validation (form-schema Zod) accepts well-formed, rejects malformed", () => {
  it("well-formed schema with every field type → accepted (201)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await request(`/admin/events/${event.id}/form/version`, {
      method: "POST",
      cookie: admin.cookie,
      body: {
        schema: {
          fields: [
            { key: "name", type: "short_text", label: "Name", required: true, sort: 0 },
            { key: "color", type: "single_choice", label: "Color", options: ["red", "blue"], sort: 1 },
            { key: "doc", type: "file_upload", label: "Doc", sort: 2 },
          ],
        },
      },
    });
    expect(res.status).toBe(201);
  });

  it("field missing required `label` → 400 validation_error", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await request(`/admin/events/${event.id}/form/version`, {
      method: "POST",
      cookie: admin.cookie,
      body: { schema: { fields: [{ key: "x", type: "short_text", sort: 0 }] } }, // no label
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "validation_error" });
  });

  it("field with an unknown `type` → 400 validation_error", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await request(`/admin/events/${event.id}/form/version`, {
      method: "POST",
      cookie: admin.cookie,
      body: { schema: { fields: [{ key: "x", type: "rocket_launch", label: "X", sort: 0 }] } },
    });
    expect(res.status).toBe(400);
  });

  it("field with empty `key` → 400 (key min length 1)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await request(`/admin/events/${event.id}/form/version`, {
      method: "POST",
      cookie: admin.cookie,
      body: { schema: { fields: [{ key: "", type: "short_text", label: "X", sort: 0 }] } },
    });
    expect(res.status).toBe(400);
  });

  it("missing top-level `fields` array → 400", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id });
    const res = await request(`/admin/events/${event.id}/form/version`, {
      method: "POST",
      cookie: admin.cookie,
      body: { schema: {} },
    });
    expect(res.status).toBe(400);
  });
});

// ===========================================================================
// 6. Timezone: windows stored as UTC timestamptz, echoed as ISO-8601 UTC
// ===========================================================================
describe("events: timezone (UTC storage + ISO round-trip)", () => {
  it("event windows stored as UTC instants and echoed unchanged on admin detail", async () => {
    const admin = await loginAs("admin");
    const checkinOpen = "2026-08-01T03:30:00.000Z"; // = 10:30 Bangkok
    const event = await makeEvent({
      createdByAdminId: admin.user.id,
      checkinOpenAt: new Date(checkinOpen),
    });
    const res = await request(`/admin/events/${event.id}`, { cookie: admin.cookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { event: { checkinOpenAt: string } };
    // Wire format is ISO-8601 UTC; the instant is preserved exactly.
    expect(new Date(body.event.checkinOpenAt).toISOString()).toBe(checkinOpen);
  });
});

// ===========================================================================
// 7. Light auth gating (behavior-focused; full matrix lives elsewhere)
// ===========================================================================
describe("events: light auth gating", () => {
  it("unauthenticated POST /admin/events → 401", async () => {
    const res = await request("/admin/events", { method: "POST", body: { title: "X" } });
    expect(res.status).toBe(401);
  });

  it("student hitting admin form version create → 403", async () => {
    const event = await makeEvent({ status: "published" });
    const student = await loginAs("student");
    const res = await request(`/admin/events/${event.id}/form/version`, {
      method: "POST",
      cookie: student.cookie,
      body: { schema: { fields: [] } },
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// Time-window ordering gates (backend enforcement — full hardening)
// ===========================================================================
describe("events: time-window ordering gates", () => {
  const T = (h: string) => `2026-07-01T${h}:00:00Z`;

  it("create rejects eventStart >= eventEnd", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, {
      title: "Bad start/end",
      eventStartAt: T("12"),
      eventEndAt: T("10"),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("create rejects checkinClose > eventEnd", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, {
      title: "Checkin past end",
      eventEndAt: T("10"),
      checkinCloseAt: T("12"),
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("create accepts a well-ordered timeline", async () => {
    const admin = await loginAs("admin");
    const res = await createEventViaApi(admin.cookie, {
      title: "Good timeline",
      registrationCloseAt: T("08"),
      checkinOpenAt: T("08"),
      eventStartAt: T("09"),
      checkinCloseAt: T("10"),
      eventEndAt: T("10"),
    });
    expect(res.status).toBe(201);
  });

  it("PATCH rejects registrationClose > eventEnd (merged with existing row)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ eventEndAt: new Date(T("10")) });
    const res = await request(`/admin/events/${event.id}`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { registrationCloseAt: T("12") },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("point-config rejects scanOutOpen before eventEnd when check-in has no early close (anti-overlap)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ eventEndAt: new Date(T("10")) }); // no checkinClose → effective = eventEnd
    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { scan_out_open_at: T("09") }, // before effective check-in close (10:00) → overlaps scan-in
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("point-config accepts scanOutOpen at/after eventEnd", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ eventEndAt: new Date(T("10")) });
    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { scan_out_open_at: T("10"), scan_out_close_at: T("12") },
    });
    expect(res.status).toBe(200);
  });

  it("point-config ALLOWS scanOutOpen before eventEnd when check-in closes earlier (no overlap)", async () => {
    const admin = await loginAs("admin");
    // Check-in closes 09:00, event ends 11:00 → scan-out may open at 09:00 (no window overlap).
    const event = await makeEvent({ checkinCloseAt: new Date(T("09")), eventEndAt: new Date(T("11")) });
    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { scan_out_open_at: T("09"), scan_out_close_at: T("12") },
    });
    expect(res.status).toBe(200);
  });

  it("point-config rejects scanOutOpen before an early check-in close", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ checkinCloseAt: new Date(T("09")), eventEndAt: new Date(T("11")) });
    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { scan_out_open_at: T("08") }, // before check-in close (09:00) → overlap
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("point-config rejects assessmentClose <= effective open (auto-open = event start)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ eventStartAt: new Date(T("09")) });
    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      // openAt omitted → auto-open at event start (09:00); close 08:00 is before → never submittable.
      body: { assessment_close_at: T("08") },
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_timing" });
  });

  it("point-config allows assessment open forever (no close)", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ eventStartAt: new Date(T("09")) });
    const res = await request(`/admin/events/${event.id}/point-config`, {
      method: "PATCH",
      cookie: admin.cookie,
      body: { assessment_enabled: true }, // no close → open forever, must be allowed
    });
    expect(res.status).toBe(200);
  });
});
