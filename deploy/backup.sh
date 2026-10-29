#!/usr/bin/env bash
# Nightly Umbrella backup: PostgreSQL dump (custom format) + the JSONL data directory (journal, settings).
# Files stay on this server in /opt/umbrella/backups (root only) and are kept for KEEP_DAYS days.
# Restore: pg_restore --clean --if-exists -d umbrella <file>.dump ; tar -xzf <file>-data.tar.gz -C /opt/umbrella
set -euo pipefail

DIR=/opt/umbrella/backups
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%d-%H%M)
umask 077
mkdir -p "$DIR"

if command -v pg_dump >/dev/null 2>&1 && grep -q "^DATABASE_URL=" /opt/umbrella/.env 2>/dev/null; then
  sudo -u postgres pg_dump -Fc umbrella > "$DIR/umbrella-$STAMP.dump.tmp"
  mv "$DIR/umbrella-$STAMP.dump.tmp" "$DIR/umbrella-$STAMP.dump"
fi
if [ -d /opt/umbrella/data ]; then
  tar -czf "$DIR/umbrella-$STAMP-data.tar.gz.tmp" -C /opt/umbrella data
  mv "$DIR/umbrella-$STAMP-data.tar.gz.tmp" "$DIR/umbrella-$STAMP-data.tar.gz"
fi

find "$DIR" -maxdepth 1 -name 'umbrella-*' -mtime +"$KEEP_DAYS" -delete
rm -f "$DIR"/*.tmp
echo "backup ok: $(ls -1 "$DIR" | grep -c "$STAMP") files, $(du -sh "$DIR" | cut -f1) total"
