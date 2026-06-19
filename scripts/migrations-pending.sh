#!/usr/bin/env bash
# Guard against partial deploys: tells the workflow if generated migrations are unapplied.
# Used to block a `services` subset that excludes `api` while migrations are pending — that
# would recreate web/db against a schema the (un-rebuilt) api was never migrated for.
# Echoes "pending" or "none". Run from the deploy clone dir; assumes db container up.
set -euo pipefail

# DB creds from the gitignored compose .env.
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a
U="${POSTGRES_USER:?POSTGRES_USER not set (need compose .env)}"
DB="${POSTGRES_DB:?POSTGRES_DB not set (need compose .env)}"

# Applied count. The node-postgres migrator stores bookkeeping in __drizzle_migrations; default
# schema is `drizzle` but some setups land it in `public`. Try `drizzle` first, then `public`.
# If neither table exists (never migrated), treat as 0 applied — don't error.
count_applied() {
  local q out
  for schema in drizzle public; do
    q="SELECT count(*) FROM ${schema}.__drizzle_migrations"
    if out=$(docker compose exec -T db psql -U "$U" -d "$DB" -tAc "$q" 2>/dev/null); then
      echo "$out" | tr -d '[:space:]'
      return 0
    fi
  done
  echo 0
}

APPLIED="$(count_applied)"
APPLIED="${APPLIED:-0}"

# Generated count = entries in the drizzle journal. Count "idx" keys (one per entry) — avoids
# a jq/python dependency on the prod box. grep -c counts matching lines.
# `|| true` + default-0: under pipefail grep exits 1 on zero matches (or unreadable file). Unparseable/zero
# ⇒ treated as pending = fail-safe (blocks a partial deploy rather than silently passing the guard).
GENERATED="$(grep -c '"idx"' drizzle/meta/_journal.json || true)"
GENERATED="${GENERATED:-0}"

if [ "$GENERATED" -gt "$APPLIED" ]; then
  echo "pending"
else
  echo "none"
fi
