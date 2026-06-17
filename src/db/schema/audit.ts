import { index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { events } from "./events";
import { registrations } from "./registrations";
import { users } from "./users";

// Central, append-only. No update/delete. Secrets redacted at app layer before insert.
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorUserId: uuid("actor_user_id").references(() => users.id),
    actorRole: text("actor_role"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    eventId: uuid("event_id").references(() => events.id),
    registrationId: uuid("registration_id").references(() => registrations.id),
    targetUserId: uuid("target_user_id").references(() => users.id),
    oldValue: jsonb("old_value"),
    newValue: jsonb("new_value"),
    reason: text("reason"),
    metadata: jsonb("metadata"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_event_idx").on(t.eventId, t.createdAt),
    index("audit_logs_registration_idx").on(t.registrationId, t.createdAt),
    index("audit_logs_target_user_idx").on(t.targetUserId, t.createdAt),
  ],
);

export type AuditLog = typeof auditLogs.$inferSelect;
