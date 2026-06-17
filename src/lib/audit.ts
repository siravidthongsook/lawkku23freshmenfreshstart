import { auditLogs } from "../db/schema/audit";
import { db, type Tx } from "../db/client";

// Append-only audit. Always redact secrets before insert.
const REDACT_KEYS = new Set([
  "plain_password",
  "password",
  "temporary_password",
  "temp_password",
  "password_hash",
  "qr_token_plain",
  "qr_token",
  "encrypted_temp_password",
  "file_content",
  "session_token",
  "reset_token",
  "token",
]);

function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k) ? "[REDACTED]" : redact(v);
    }
    return out;
  }
  return value;
}

export type AuditEntry = {
  actorUserId?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  eventId?: string | null;
  registrationId?: string | null;
  targetUserId?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  reason?: string | null;
  metadata?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
};

// Write one audit row. Pass a Tx to bind it to the surrounding transaction; else uses global db.
export async function writeAudit(entry: AuditEntry, tx?: Tx): Promise<void> {
  const exec = tx ?? db;
  await exec.insert(auditLogs).values({
    actorUserId: entry.actorUserId ?? null,
    actorRole: entry.actorRole ?? null,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    eventId: entry.eventId ?? null,
    registrationId: entry.registrationId ?? null,
    targetUserId: entry.targetUserId ?? null,
    oldValue: entry.oldValue === undefined ? null : redact(entry.oldValue),
    newValue: entry.newValue === undefined ? null : redact(entry.newValue),
    reason: entry.reason ?? null,
    metadata: entry.metadata === undefined ? null : redact(entry.metadata),
    ipAddress: entry.ipAddress ?? null,
    userAgent: entry.userAgent ?? null,
  });
}
