-- PII-stripped audit view + read-only Grafana role (design C2/C3).
--
-- WHY: audit_logs CONTAINS PII (ip_address, user_agent, and old_value/new_value
-- jsonb that profileSnapshot fills with email/student_id/full_name/phone — see
-- src/db/schema/audit.ts + design §4). Grafana is the only host-exposed service,
-- so it must NEVER touch the raw table. It reads ONLY this view, ONLY as a role
-- with SELECT-only grants — so the Grafana SQL editor can never DELETE/UPDATE and
-- the append-only invariant survives.
--
-- Run this ONCE on the prod DB, out-of-band, as the migration/owner role.
-- It is NOT a Drizzle migration (Grafana is a separate lifecycle; this only
-- creates a downstream-read view + role, never alters app schema).

-- 1) The safe view: non-PII columns only.
-- Exposed: id, action, entity_type, entity_id, actor_user_id, actor_role,
--          target_user_id, event_id, registration_id, reason, created_at.
-- Deliberately EXCLUDED (PII / forensic-only):
--   ip_address, user_agent  -> network PII
--   old_value, new_value    -> jsonb that embeds email/student_id/full_name/phone
--   metadata                -> free-form jsonb, can embed anything; not safe to expose broadly
CREATE OR REPLACE VIEW audit_logs_safe AS
SELECT
  id,
  action,
  entity_type,
  entity_id,
  actor_user_id,   -- uuid only; never email/student_id (CLAUDE.md invariant)
  actor_role,
  target_user_id,  -- uuid only
  event_id,
  registration_id,
  reason,          -- required on sensitive actions; free text but human-authored, no auto-PII
  created_at
FROM audit_logs;

-- 2) Dedicated read-only role for the Grafana Postgres datasource.
-- CRITICAL: this role must NEVER be the migration/owner role (that role can
-- DELETE FROM audit_logs, which would break the append-only invariant through
-- Grafana's ad-hoc SQL editor). SELECT-only, and ONLY on the safe view.
--
-- Set the password out-of-band (do not commit it). The datasource pulls user +
-- password from env (see datasources.yml -> ${GRAFANA_PG_USER}/${GRAFANA_PG_PASSWORD}).
-- Example (run as owner, substitute a real secret):
--   ALTER ROLE grafana_ro WITH PASSWORD 'set-a-strong-secret-out-of-band';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'grafana_ro') THEN
    -- LOGIN role, no password yet -> set it with ALTER ROLE out-of-band.
    CREATE ROLE grafana_ro WITH LOGIN;
  END IF;
END
$$;

-- 3) Grants: connect + read the safe view ONLY.
-- Replace <DBNAME> with the actual database (e.g. lawkku_freshstart23).
-- GRANT CONNECT ON DATABASE <DBNAME> TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON audit_logs_safe TO grafana_ro;

-- 4) EXPLICITLY NO grant on the raw table. (No GRANT ... ON audit_logs.)
-- Defense in depth: make sure a prior broad grant / PUBLIC default isn't leaking it.
REVOKE ALL ON audit_logs FROM grafana_ro;
-- Also ensure the role can't read other app tables by default.
-- (If PUBLIC has broad SELECT in your DB, tighten that separately.)
