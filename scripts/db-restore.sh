#!/usr/bin/env bash
# Restore a DB dump (and optionally a storage tar) taken by db-backup.sh.
# DB restore OVERWRITES all rows since the backup — destructive, manual only.
# Usage: db-restore.sh <db-backup.sql.gz> [storage-backup.tar.gz]
set -euo pipefail

DB_BACKUP="${1:?usage: db-restore.sh <db-backup.sql.gz> [storage-backup.tar.gz]}"
STORAGE_BACKUP="${2:-}"

# DB creds from the gitignored compose .env.
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a
U="${POSTGRES_USER:?POSTGRES_USER not set (need compose .env)}"
DB="${POSTGRES_DB:?POSTGRES_DB not set (need compose .env)}"

# 1. Guard: file exists + gzip integrity ok BEFORE touching the live DB.
[ -f "$DB_BACKUP" ] || { echo "::error::db backup not found: $DB_BACKUP" >&2; exit 1; }
gzip -t "$DB_BACKUP" || { echo "::error::db backup failed gzip integrity: $DB_BACKUP" >&2; exit 1; }

echo "WARNING: restoring DB from $DB_BACKUP — this OVERWRITES all rows since the backup."

# 2. DB restore. --single-transaction + ON_ERROR_STOP=1 => a failed restore rolls back the
# whole thing and exits nonzero (a naive pipe would swallow errors and leave a half-restored DB).
gunzip -c "$DB_BACKUP" \
  | docker compose exec -T db psql -U "$U" -d "$DB" --single-transaction -v ON_ERROR_STOP=1

# 3. Optional storage restore — only after validating the tar so we never wipe on a bad archive.
if [ -n "$STORAGE_BACKUP" ]; then
  [ -f "$STORAGE_BACKUP" ] || { echo "::error::storage backup not found: $STORAGE_BACKUP" >&2; exit 1; }
  gzip -t "$STORAGE_BACKUP" || { echo "::error::storage backup failed gzip integrity" >&2; exit 1; }
  tar -tzf "$STORAGE_BACKUP" >/dev/null || { echo "::error::storage backup not a valid tar" >&2; exit 1; }

  BAK_DIR="$(cd "$(dirname "$STORAGE_BACKUP")" && pwd)"
  BASENAME="$(basename "$STORAGE_BACKUP")"
  echo "WARNING: wiping storage volume then restoring from $BASENAME"
  # Single-quoted script + positional arg: host never expands $BASENAME next to rm -rf, and it stays quoted inside.
  if ! docker run --rm \
    -v eticket_storage:/data \
    -v "$BAK_DIR":/bak \
    alpine sh -c 'rm -rf /data/* && tar xzf "/bak/$1" -C /data' _ "$BASENAME"; then
    echo "::error::storage restore failed — volume may be half-restored (old files wiped, new not fully extracted)" >&2
    exit 1
  fi
fi

echo "restore complete"
