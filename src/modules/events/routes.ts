import { Hono } from "hono";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "../../db/client";
import { events } from "../../db/schema/events";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import type { AppVariables } from "../../lib/context";
import { badRequest, notFound } from "../../lib/errors";
import { canManageEvents } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { computeEventStatus, ensureUniqueSlug, publicEventView } from "./service";
import {
  createEventSchema,
  eventIdParam,
  publicIdParam,
  slugParam,
  statusChangeSchema,
  updateEventSchema,
  visibilityChangeSchema,
} from "./schema";

const router = new Hono<{ Variables: AppVariables }>();

// ---------- Public ----------

// GET /events — public list: published+listed, plus cancelled+listed (with cancelled flag).
// Hides draft / unlisted / archived.
router.get("/events", async (c) => {
  const rows = await db
    .select()
    .from(events)
    .where(
      and(eq(events.visibility, "listed"), inArray(events.status, ["published", "cancelled"])),
    )
    .orderBy(desc(events.eventStartAt));

  const now = new Date();
  const out = await Promise.all(
    rows.map(async (e) => publicEventView(e, await computeEventStatus(e, { now }))),
  );
  return c.json({ events: out });
});

// GET /events/:slug — public event page by slug. draft → 404 (not public).
router.get("/events/:slug", async (c) => {
  const { slug } = slugParam.parse(c.req.param());
  const [event] = await db.select().from(events).where(eq(events.publicSlug, slug)).limit(1);
  if (!event || event.status === "draft") throw notFound("Event not found");

  // cancelled → shown with cancelled flag (no register); archived → read-only; published → normal.
  const computed = await computeEventStatus(event);
  return c.json({ event: publicEventView(event, computed) });
});

// GET /e/:publicId — permanent QR URL: resolve by public_id → 302 to current /events/:slug.
router.get("/e/:publicId", async (c) => {
  const { publicId } = publicIdParam.parse(c.req.param());
  const [event] = await db.select().from(events).where(eq(events.publicId, publicId)).limit(1);
  // Hide non-public draft; otherwise redirect to the current pretty slug.
  if (!event || event.status === "draft") throw notFound("Event not found");
  return c.redirect(`/events/${event.publicSlug}`, 302);
});

// ---------- Admin ---------- (all guarded by canManageEvents)

router.use("/admin/events", requireAuth, requirePermission(canManageEvents));
router.use("/admin/events/*", requireAuth, requirePermission(canManageEvents));

// GET /admin/events — all events incl. draft/archived.
router.get("/admin/events", async (c) => {
  const rows = await db.select().from(events).orderBy(desc(events.createdAt));
  return c.json({ events: rows });
});

// POST /admin/events — create as draft. Auto slug (slugify title) unique; public_id defaultRandom.
router.post("/admin/events", async (c) => {
  const body = createEventSchema.parse(await c.req.json());
  const user = c.get("user");

  // capacity_limit must be present when capacity_enabled.
  if (body.capacityEnabled && body.capacityLimit == null) {
    throw badRequest("capacity_limit_required", "capacity_limit required when capacity_enabled");
  }

  const slug = await ensureUniqueSlug(db, body.publicSlug ?? body.title);

  const [created] = await db
    .insert(events)
    .values({
      title: body.title,
      description: body.description ?? null,
      location: body.location ?? null,
      publicSlug: slug,
      status: "draft", // always created as draft
      registrationMode: body.registrationMode ?? "closed",
      registrationOpenAt: body.registrationOpenAt ?? null,
      registrationCloseAt: body.registrationCloseAt ?? null,
      checkinOpenAt: body.checkinOpenAt ?? null,
      checkinCloseAt: body.checkinCloseAt ?? null,
      eventStartAt: body.eventStartAt ?? null,
      eventEndAt: body.eventEndAt ?? null,
      capacityEnabled: body.capacityEnabled ?? false,
      capacityLimit: body.capacityLimit ?? null,
      waitlistEnabled: body.waitlistEnabled ?? false,
      allowStudentCancelRegistration: body.allowStudentCancelRegistration ?? false,
      cancelRegistrationCloseAt: body.cancelRegistrationCloseAt ?? null,
      allowStudentEditRegistration: body.allowStudentEditRegistration ?? false,
      editRegistrationCloseAt: body.editRegistrationCloseAt ?? null,
      createdByAdminId: user.id,
    })
    .returning();

  return c.json({ event: created }, 201);
});

// GET /admin/events/:eventId — detail (admin view = full row + computed status).
router.get("/admin/events/:eventId", async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw notFound("Event not found");
  const computed = await computeEventStatus(event);
  return c.json({ event, computed });
});

// PATCH /admin/events/:eventId — edit fields/windows/config. Slug change → audit event_slug_changed.
router.patch("/admin/events/:eventId", async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = updateEventSchema.parse(await c.req.json());
  const user = c.get("user");
  const meta = requestMeta(c);

  const [existing] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!existing) throw notFound("Event not found");

  // Resolve effective capacity flags (incoming-or-existing) to validate the invariant.
  const capacityEnabled = body.capacityEnabled ?? existing.capacityEnabled;
  const capacityLimit =
    body.capacityLimit !== undefined ? body.capacityLimit : existing.capacityLimit;
  if (capacityEnabled && capacityLimit == null) {
    throw badRequest("capacity_limit_required", "capacity_limit required when capacity_enabled");
  }

  // Slug handling: if caller sent a slug, normalize + ensure uniqueness; detect change for audit.
  let newSlug = existing.publicSlug;
  if (body.publicSlug !== undefined) {
    newSlug = await ensureUniqueSlug(db, body.publicSlug, eventId);
  }
  const slugChanged = newSlug !== existing.publicSlug;

  // Build patch only from provided keys (avoid clobbering with undefined).
  const patch: Record<string, unknown> = { updatedAt: new Date(), publicSlug: newSlug };
  const assign = <K extends keyof typeof body>(k: K) => {
    if (body[k] !== undefined) patch[k as string] = body[k];
  };
  (
    [
      "title",
      "description",
      "location",
      "registrationMode",
      "registrationOpenAt",
      "registrationCloseAt",
      "checkinOpenAt",
      "checkinCloseAt",
      "eventStartAt",
      "eventEndAt",
      "capacityEnabled",
      "capacityLimit",
      "waitlistEnabled",
      "allowStudentCancelRegistration",
      "cancelRegistrationCloseAt",
      "allowStudentEditRegistration",
      "editRegistrationCloseAt",
    ] as const
  ).forEach(assign);

  const [updated] = await db.update(events).set(patch).where(eq(events.id, eventId)).returning();

  // Audit slug change specifically (spec: slug change is a tracked sensitive change).
  if (slugChanged) {
    await writeAudit({
      actorUserId: user.id,
      actorRole: user.role,
      action: "event_slug_changed",
      entityType: "event",
      entityId: eventId,
      eventId,
      oldValue: { publicSlug: existing.publicSlug },
      newValue: { publicSlug: newSlug },
      ...meta,
    });
  }

  return c.json({ event: updated });
});

// POST /admin/events/:eventId/status — non-destructive status move; audit event_status_changed.
router.post("/admin/events/:eventId/status", async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = statusChangeSchema.parse(await c.req.json());
  const user = c.get("user");
  const meta = requestMeta(c);

  const [existing] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!existing) throw notFound("Event not found");

  if (existing.status === body.status) {
    return c.json({ event: existing }); // no-op, nothing to audit
  }

  const [updated] = await db
    .update(events)
    .set({ status: body.status, updatedAt: new Date() })
    .where(eq(events.id, eventId))
    .returning();

  await writeAudit({
    actorUserId: user.id,
    actorRole: user.role,
    action: "event_status_changed",
    entityType: "event",
    entityId: eventId,
    eventId,
    oldValue: { status: existing.status },
    newValue: { status: body.status },
    reason: body.reason ?? null,
    ...meta,
  });

  return c.json({ event: updated });
});

// POST /admin/events/:eventId/visibility — audit event_visibility_changed.
router.post("/admin/events/:eventId/visibility", async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = visibilityChangeSchema.parse(await c.req.json());
  const user = c.get("user");
  const meta = requestMeta(c);

  const [existing] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!existing) throw notFound("Event not found");

  if (existing.visibility === body.visibility) {
    return c.json({ event: existing }); // no-op
  }

  const [updated] = await db
    .update(events)
    .set({ visibility: body.visibility, updatedAt: new Date() })
    .where(eq(events.id, eventId))
    .returning();

  await writeAudit({
    actorUserId: user.id,
    actorRole: user.role,
    action: "event_visibility_changed",
    entityType: "event",
    entityId: eventId,
    eventId,
    oldValue: { visibility: existing.visibility },
    newValue: { visibility: body.visibility },
    reason: body.reason ?? null,
    ...meta,
  });

  return c.json({ event: updated });
});

export default router;
