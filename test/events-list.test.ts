import { describe, it, expect } from "vitest";
import { request } from "./helpers/db";
import { loginAs } from "./helpers/auth";
import { makeEvent, makeRegistration } from "./helpers/factories";

// ---------------------------------------------------------------------------
// GET /admin/events list query — the main admin surface. Only its auth-gate was
// covered before; this exercises q-search, status filter, sort, pagination,
// per-row counts, effectiveState, and the excludeArchived flag (see KNOWN BUG).
// Response shape (routes.ts ~232): { events: [...row + counts + effectiveState], total, limit, offset }.
// ---------------------------------------------------------------------------

type ListRow = {
  id: string;
  title: string;
  status: string;
  registeredCount: number;
  checkedInCount: number;
  waitlistedCount: number;
  cancelledCount: number;
  effectiveState: unknown;
};
type ListBody = { events: ListRow[]; total: number; limit: number; offset: number };

async function list(cookie: string, qs = ""): Promise<{ status: number; body: ListBody }> {
  const res = await request(`/admin/events${qs}`, { cookie });
  return { status: res.status, body: (await res.json()) as ListBody };
}

// =====================================================================
// Text search (q) over title + slug
// =====================================================================
describe("admin events list: text search (q)", () => {
  it("q matches title (case-insensitive ilike) and excludes non-matches", async () => {
    const admin = await loginAs("admin");
    const a = await makeEvent({ createdByAdminId: admin.user.id, title: "Orientation Day", publicSlug: "q-orient" });
    const b = await makeEvent({ createdByAdminId: admin.user.id, title: "Closing Gala", publicSlug: "q-gala" });

    const { status, body } = await list(admin.cookie, "?q=orient");
    expect(status).toBe(200);
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain(a.id);
    expect(ids).not.toContain(b.id);
  });

  it("q matches slug too", async () => {
    const admin = await loginAs("admin");
    const a = await makeEvent({ createdByAdminId: admin.user.id, title: "Whatever", publicSlug: "unique-slug-zzz" });
    const { body } = await list(admin.cookie, "?q=unique-slug-zzz");
    expect(body.events.map((e) => e.id)).toContain(a.id);
  });
});

// =====================================================================
// status filter
// =====================================================================
describe("admin events list: status filter", () => {
  it("?status=draft returns only draft events", async () => {
    const admin = await loginAs("admin");
    const draft = await makeEvent({ createdByAdminId: admin.user.id, status: "draft" });
    const pub = await makeEvent({ createdByAdminId: admin.user.id, status: "published" });

    const { body } = await list(admin.cookie, "?status=draft");
    const ids = body.events.map((e) => e.id);
    expect(ids).toContain(draft.id);
    expect(ids).not.toContain(pub.id);
    expect(body.events.every((e) => e.status === "draft")).toBe(true);
  });

  it("invalid status value → 400 validation_error (enum rejects it)", async () => {
    const admin = await loginAs("admin");
    const res = await request("/admin/events?status=bogus", { cookie: admin.cookie });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string }).toMatchObject({ error: "validation_error" });
  });
});

// =====================================================================
// Sort modes
// =====================================================================
describe("admin events list: sort modes", () => {
  it("sort=title_asc orders rows alphabetically by title", async () => {
    const admin = await loginAs("admin");
    // Distinctive prefix so we can isolate these three among any shared-DB rows.
    await makeEvent({ createdByAdminId: admin.user.id, title: "ZZZ-charlie", publicSlug: "s-c" });
    await makeEvent({ createdByAdminId: admin.user.id, title: "ZZZ-alpha", publicSlug: "s-a" });
    await makeEvent({ createdByAdminId: admin.user.id, title: "ZZZ-bravo", publicSlug: "s-b" });

    const { body } = await list(admin.cookie, "?sort=title_asc&limit=100");
    const ours = body.events.filter((e) => e.title.startsWith("ZZZ-")).map((e) => e.title);
    expect(ours).toEqual(["ZZZ-alpha", "ZZZ-bravo", "ZZZ-charlie"]);
  });

  it("sort=date_asc puts the earliest event start first; nulls last", async () => {
    const admin = await loginAs("admin");
    const early = await makeEvent({
      createdByAdminId: admin.user.id,
      title: "DSORT early",
      publicSlug: "d-early",
      eventStartAt: new Date("2026-01-01T00:00:00Z"),
    });
    const late = await makeEvent({
      createdByAdminId: admin.user.id,
      title: "DSORT late",
      publicSlug: "d-late",
      eventStartAt: new Date("2026-12-01T00:00:00Z"),
    });

    const { body } = await list(admin.cookie, "?sort=date_asc&limit=100");
    const ours = body.events.filter((e) => e.title.startsWith("DSORT")).map((e) => e.id);
    expect(ours.indexOf(early.id)).toBeLessThan(ours.indexOf(late.id));
  });
});

// =====================================================================
// Pagination (limit / offset / total)
// =====================================================================
describe("admin events list: pagination", () => {
  it("limit caps page size; total reflects the full (pre-pagination) count", async () => {
    const admin = await loginAs("admin");
    for (let i = 0; i < 5; i++) {
      await makeEvent({ createdByAdminId: admin.user.id, title: `PAGE ${i}`, publicSlug: `pg-${i}` });
    }
    const { body } = await list(admin.cookie, "?q=PAGE&limit=2&offset=0");
    expect(body.limit).toBe(2);
    expect(body.offset).toBe(0);
    expect(body.events.length).toBe(2); // page is capped
    expect(body.total).toBe(5); // but total counts all matches
  });

  it("offset walks the page window without overlap", async () => {
    const admin = await loginAs("admin");
    for (let i = 0; i < 4; i++) {
      await makeEvent({ createdByAdminId: admin.user.id, title: `WALK ${i}`, publicSlug: `wk-${i}` });
    }
    const p1 = await list(admin.cookie, "?q=WALK&limit=2&offset=0&sort=title_asc");
    const p2 = await list(admin.cookie, "?q=WALK&limit=2&offset=2&sort=title_asc");
    const ids1 = p1.body.events.map((e) => e.id);
    const ids2 = p2.body.events.map((e) => e.id);
    expect(ids1.length).toBe(2);
    expect(ids2.length).toBe(2);
    expect(ids1.some((id) => ids2.includes(id))).toBe(false); // disjoint pages
    expect(p1.body.total).toBe(4);
  });
});

// =====================================================================
// Per-row registration counts + effectiveState
// =====================================================================
describe("admin events list: per-row counts + effectiveState", () => {
  it("counts registered / checked_in / waitlisted / cancelled per row", async () => {
    const admin = await loginAs("admin");
    const event = await makeEvent({ createdByAdminId: admin.user.id, title: "COUNTS", publicSlug: "counts-evt" });

    // 2 registered, 1 checked_in, 1 waitlisted, 1 cancelled.
    await makeRegistration({ event, status: "registered" });
    await makeRegistration({ event, status: "registered" });
    await makeRegistration({ event, status: "checked_in" });
    await makeRegistration({ event, status: "waitlisted" });
    await makeRegistration({ event, status: "cancelled" });

    const { body } = await list(admin.cookie, "?q=COUNTS&limit=100");
    const row = body.events.find((e) => e.id === event.id);
    expect(row).toBeDefined();
    expect(row!.registeredCount).toBe(2);
    expect(row!.checkedInCount).toBe(1);
    expect(row!.waitlistedCount).toBe(1);
    expect(row!.cancelledCount).toBe(1);
  });

  it("every row carries a server-computed effectiveState", async () => {
    const admin = await loginAs("admin");
    await makeEvent({ createdByAdminId: admin.user.id, title: "ESTATE", publicSlug: "estate-evt" });
    const { body } = await list(admin.cookie, "?q=ESTATE");
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events.every((e) => e.effectiveState !== undefined && e.effectiveState !== null)).toBe(true);
  });
});

// =====================================================================
// excludeArchived flag
// =====================================================================
describe("admin events list: excludeArchived flag", () => {
  it("?excludeArchived=true EXCLUDES archived events", async () => {
    const admin = await loginAs("admin");
    const arch = await makeEvent({ createdByAdminId: admin.user.id, status: "archived", title: "EXARCH a", publicSlug: "exarch-a" });
    const pub = await makeEvent({ createdByAdminId: admin.user.id, status: "published", title: "EXARCH p", publicSlug: "exarch-p" });

    const { body } = await list(admin.cookie, "?q=EXARCH&excludeArchived=true&limit=100");
    const ids = body.events.map((e) => e.id);
    expect(ids).not.toContain(arch.id);
    expect(ids).toContain(pub.id);
  });

  it("absent excludeArchived INCLUDES archived events (default = show all)", async () => {
    const admin = await loginAs("admin");
    const arch = await makeEvent({ createdByAdminId: admin.user.id, status: "archived", title: "INCARCH a", publicSlug: "incarch-a" });
    const { body } = await list(admin.cookie, "?q=INCARCH&limit=100");
    expect(body.events.map((e) => e.id)).toContain(arch.id); // no flag → archived visible
  });

  // KNOWN BUG: excludeArchived uses z.coerce.boolean() (schema.ts:72). z.coerce.boolean()
  // coerces ANY non-empty string to true — so the literal string "false" becomes boolean
  // `true`, which WRONGLY excludes archived events even though the caller asked to include
  // them. Correct behavior: ?excludeArchived=false should INCLUDE archived events.
  // This test asserts the CORRECT contract and is expected to FAIL until the schema is
  // fixed (e.g. a proper string→boolean transform). Source NOT modified per task scope.
  it.fails("?excludeArchived=false INCLUDES archived events (z.coerce.boolean() footgun)", async () => {
    const admin = await loginAs("admin");
    const arch = await makeEvent({ createdByAdminId: admin.user.id, status: "archived", title: "FALSEARCH a", publicSlug: "falsearch-a" });
    const { body } = await list(admin.cookie, "?q=FALSEARCH&excludeArchived=false&limit=100");
    // Expected: archived included because the caller said false. Actual: "false" coerces to
    // true → archived excluded → this assertion fails → it.fails() turns the red into green.
    expect(body.events.map((e) => e.id)).toContain(arch.id);
  });
});
