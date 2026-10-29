#!/bin/sh
set -eu

: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
mkdir -p "$BACKUP_DIR"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
OUT="$BACKUP_DIR/product-umbrella-$STAMP.sql.gz"
pg_dump "$DATABASE_URL" | gzip > "$OUT"
printf '%s\n' "$OUT"
