import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/client";
import { events } from "../../db/schema/events";
import { eventFormVersions } from "../../db/schema/forms";
import { requireAuth, requirePermission, requestMeta } from "../../lib/auth-middleware";
import { writeAudit } from "../../lib/audit";
import type { AppVariables } from "../../lib/context";
import { notFound } from "../../lib/errors";
import { formSchema, type FormSchema } from "../../lib/form-schema";
import { canManageEvents } from "../../lib/permissions";
import { eventIdParam, createVersionSchema, updateFormSchema } from "./schema";
import { createNewVersion, getActiveVersion, hasSubmissions, isStructuralChange } from "./service";

const router = new Hono<{ Variables: AppVariables }>();

// All form management endpoints are admin-only (event management permission).
router.use("/admin/events/:eventId/form", requireAuth, requirePermission(canManageEvents));
router.use("/admin/events/:eventId/form/*", requireAuth, requirePermission(canManageEvents));

// Guard: event must exist before any form op.
async function loadEvent(eventId: string) {
  const [event] = await db.select().from(events).where(eq(events.id, eventId)).limit(1);
  if (!event) throw notFound("Event not found");
  return event;
}

// GET /admin/events/:eventId/form — active form schema (is_active version).
router.get("/admin/events/:eventId/form", async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  await loadEvent(eventId);
  const active = await getActiveVersion(eventId);
  if (!active) return c.json({ form: null }); // no form built yet
  return c.json({ form: active });
});

// PATCH /admin/events/:eventId/form — safe edits in place; structural edits force a new version
// once submissions exist. If no active version yet, create version 1.
router.patch("/admin/events/:eventId/form", async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = updateFormSchema.parse(await c.req.json());
  const user = c.get("user");
  const meta = requestMeta(c);
  await loadEvent(eventId);

  const active = await getActiveVersion(eventId);

  // No active version yet → bootstrap version 1 (always allowed; no submissions can reference it).
  if (!active) {
    const created = await createNewVersion(db, {
      eventId,
      schema: body.schema,
      adminId: user.id,
    });
    await writeAudit({
      actorUserId: user.id,
      actorRole: user.role,
      action: "form_version_created",
      entityType: "event_form_version",
      entityId: created.id,
      eventId,
      newValue: { versionNumber: created.versionNumber },
      ...meta,
    });
    return c.json({ form: created, versioned: true });
  }

  const oldSchema = formSchema.parse(active.schemaJson) as FormSchema;
  const structural = isStructuralChange(oldSchema, body.schema);
  const submissionsExist = await hasSubmissions(eventId);

  // Structural change WITH existing submissions → must create a new version (old regs keep old).
  if (structural && submissionsExist) {
    const created = await createNewVersion(db, {
      eventId,
      schema: body.schema,
      adminId: user.id,
    });
    await writeAudit({
      actorUserId: user.id,
      actorRole: user.role,
      action: "form_version_created",
      entityType: "event_form_version",
      entityId: created.id,
      eventId,
      oldValue: { versionNumber: active.versionNumber },
      newValue: { versionNumber: created.versionNumber, reason: "structural_change" },
      ...meta,
    });
    return c.json({ form: created, versioned: true });
  }

  // Safe edit, OR structural-but-no-submissions → edit active version in place.
  const [updated] = await db
    .update(eventFormVersions)
    .set({ schemaJson: body.schema })
    .where(eq(eventFormVersions.id, active.id))
    .returning();

  return c.json({ form: updated, versioned: false });
});

// POST /admin/events/:eventId/form/version — explicitly create a new version; audit form_version_created.
router.post("/admin/events/:eventId/form/version", async (c) => {
  const { eventId } = eventIdParam.parse(c.req.param());
  const body = createVersionSchema.parse(await c.req.json());
  const user = c.get("user");
  const meta = requestMeta(c);
  await loadEvent(eventId);

  const prev = await getActiveVersion(eventId);
  const created = await createNewVersion(db, {
    eventId,
    schema: body.schema,
    adminId: user.id,
  });

  await writeAudit({
    actorUserId: user.id,
    actorRole: user.role,
    action: "form_version_created",
    entityType: "event_form_version",
    entityId: created.id,
    eventId,
    oldValue: prev ? { versionNumber: prev.versionNumber } : null,
    newValue: { versionNumber: created.versionNumber },
    reason: body.reason ?? null,
    ...meta,
  });

  return c.json({ form: created }, 201);
});

export default router;
