#!/usr/bin/env bash
# Pre-deploy backup: DB dump + storage volume tar, both tagged with the current code SHA.
# Backup = belt-and-suspenders. drizzle migrate is atomic per run, so a FAILED migrate needs
# no restore (schema untouched). Restore is only for a bad-but-SUCCEEDED migration.
# Run from the deploy clone dir; assumes the db container is up. Arg $1 = short SHA tag.
set -euo pipefail

SHA="${1:?usage: db-backup.sh <short-sha>}"
TS="$(date +%Y%m%d-%H%M%S)"
BAK_DIR="$HOME/eticket-backups"
KEEP=20
MIN_BYTES=1024 # a valid --clean dump is always well over 1KB; smaller == truncated/empty

mkdir -p "$BAK_DIR"

# DB creds come from the gitignored compose .env (POSTGRES_USER/POSTGRES_DB).
# shellcheck disable=SC1091
[ -f .env ] && set -a && . ./.env && set +a
U="${POSTGRES_USER:?POSTGRES_USER not set (need compose .env)}"
DB="${POSTGRES_DB:?POSTGRES_DB not set (need compose .env)}"

DB_FILE="$BAK_DIR/db-$TS-$SHA.sql.gz"
STORAGE_FILE="$BAK_DIR/storage-$TS-$SHA.tar.gz"

# 1. DB dump (--clean --if-exists => restorable over a live DB).
docker compose exec -T db pg_dump -U "$U" --clean --if-exists "$DB" | gzip > "$DB_FILE"

# Validate: gzip -t catches truncation; size floor catches an empty/near-empty dump.
gzip -t "$DB_FILE"
db_size=$(wc -c < "$DB_FILE")
if [ "$db_size" -lt "$MIN_BYTES" ]; then
  echo "::error::db backup $DB_FILE too small ($db_size bytes) — likely truncated" >&2
  exit 1
fi

# 2. Storage volume tar (same tag). Read-only mount so we never mutate live storage.
# Use basename of $STORAGE_FILE so the in-container path can't drift from the validation/echo below.
docker run --rm \
  -v eticket_storage:/data:ro \
  -v "$BAK_DIR":/bak \
  alpine tar czf "/bak/$(basename "$STORAGE_FILE")" -C /data .

# Validate the tar both ways: gzip integrity + listable archive.
gzip -t "$STORAGE_FILE"
tar -tzf "$STORAGE_FILE" >/dev/null

# 3. Prune ALWAYS (not gated on success above — keep the box from filling regardless).
prune() {
  local prefix="$1" old
  # newest first; delete everything past the newest $KEEP. `|| true` so "no matches" under
  # pipefail doesn't abort the script.
  while read -r old; do
    [ -n "$old" ] && rm -f "$old"
  done < <(ls -1t "$BAK_DIR/$prefix"* 2>/dev/null | tail -n "+$((KEEP + 1))" || true)
}
prune "db-"
prune "storage-"

# 4. Emit the two result paths as KEY lines on stdout so the workflow can grep them robustly
# (immune to any stray docker stdout). Human/log output above all goes to stderr.
echo "db_backup=$DB_FILE"
echo "storage_backup=$STORAGE_FILE"
