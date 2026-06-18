import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import type { AppVariables } from "../../lib/context";
import { db } from "../../db/client";
import { auditLogs } from "../../db/schema/audit";
import { registrations } from "../../db/schema/registrations";
import { requireAuth, requirePermission } from "../../lib/auth-middleware";
import { canViewAuditLogs } from "../../lib/permissions";
import { notFound } from "../../lib/errors";

const router = new Hono<{ Variables: AppVariables }>();
const adminOnly = [requireAuth, requirePermission(canViewAuditLogs)] as const;

// Global audit-log filters + pagination. Staff get nothing (permission denies).
const listFiltersSchema = z.object({
  action: z.string().min(1).optional(),
  entity_type: z.string().min(1).optional(),
  event_id: z.string().uuid().optional(),
  target_user_id: z.string().uuid().optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// Wire shape — secrets were already redacted at write-time; just serialize.
function toWire(r: typeof auditLogs.$inferSelect) {
  return {
    id: r.id,
    actor_user_id: r.actorUserId,
    actor_role: r.actorRole,
    action: r.action,
    entity_type: r.entityType,
    entity_id: r.entityId,
    event_id: r.eventId,
    registration_id: r.registrationId,
    target_user_id: r.targetUserId,
    old_value: r.oldValue,
    new_value: r.newValue,
    reason: r.reason,
    metadata: r.metadata,
    ip_address: r.ipAddress,
    user_agent: r.userAgent,
    created_at: r.createdAt.toISOString(),
  };
}

// GET /admin/audit-logs — global, filterable, paginated (newest first).
router.get("/admin/audit-logs", ...adminOnly, zValidator("query", listFiltersSchema), async (c) => {
  const f = c.req.valid("query");
  const conds: SQL[] = [];
  if (f.action) conds.push(eq(auditLogs.action, f.action));
  if (f.entity_type) conds.push(eq(auditLogs.entityType, f.entity_type));
  if (f.event_id) conds.push(eq(auditLogs.eventId, f.event_id));
  if (f.target_user_id) conds.push(eq(auditLogs.targetUserId, f.target_user_id));
  if (f.from) conds.push(gte(auditLogs.createdAt, new Date(f.from)));
  if (f.to) conds.push(lte(auditLogs.createdAt, new Date(f.to)));

  const where = conds.length ? and(...conds) : undefined;

  // Return total so the pager can disable Next on the exact-page-size final page (no empty page).
  const [countRow] = await db.select({ c: sql<number>`count(*)::int` }).from(auditLogs).where(where);
  const total = countRow?.c ?? 0;

  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt))
    .limit(f.limit)
    .offset(f.offset);

  return c.json({ logs: rows.map(toWire), total, limit: f.limit, offset: f.offset });
});

// GET /admin/registrations/:registrationId/audit-logs — per-registration history (newest first).
router.get(
  "/admin/registrations/:registrationId/audit-logs",
  ...adminOnly,
  async (c) => {
    const registrationId = c.req.param("registrationId");
    const [reg] = await db
      .select({ id: registrations.id })
      .from(registrations)
      .where(eq(registrations.id, registrationId))
      .limit(1);
    if (!reg) throw notFound("Registration not found");

    const rows = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.registrationId, registrationId))
      .orderBy(desc(auditLogs.createdAt));

    return c.json({ logs: rows.map(toWire) });
  },
);

export default router;
