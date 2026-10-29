#!/usr/bin/env bash
# Nightly Umbrella backup: PostgreSQL dump (custom format) + the JSONL data directory (journal, settings).
# Files stay on this server in /opt/umbrella/backups (root only) and are kept for KEEP_DAYS days.
# Restore: README «Бэкапы» (stop the service, pg_restore the dump, unpack the data archive, start).
# On failure systemd runs umbrella-failed@umbrella-backup.service.service (deploy/notify-failure.sh),
# which appends to backups/LAST_FAILED; the next successful run removes its backup lines.
set -euo pipefail

ROOT=${UMBRELLA_ROOT:-/opt/umbrella}
DIR=$ROOT/backups
KEEP_DAYS=${KEEP_DAYS:-14}
STAMP=$(date -u +%Y%m%d-%H%M)
umask 077
mkdir -p "$DIR"

SNAP=""
cleanup() { if [ -n "$SNAP" ]; then rm -rf -- "$SNAP"; fi; rm -f "$DIR"/*.tmp; }
trap cleanup EXIT

if command -v pg_dump >/dev/null 2>&1 && grep -q "^DATABASE_URL=" "$ROOT/.env" 2>/dev/null; then
  # The redirect is done by root on purpose: the dump file is root-only.
  # shellcheck disable=SC2024
  sudo -u postgres pg_dump -Fc umbrella > "$DIR/umbrella-$STAMP.dump.tmp"
  mv "$DIR/umbrella-$STAMP.dump.tmp" "$DIR/umbrella-$STAMP.dump"
fi

if [ -d "$ROOT/data" ]; then
  # The service keeps appending to data/events.jsonl while we run. tar on a growing file can fail ("file changed
  # as we read it") or end mid-line, so archive a snapshot instead: copy the directory (reflink where the
  # filesystem supports it), drop a half-written last journal line, fsync, then tar the copy.
  SNAP=$(mktemp -d "$DIR/.snapshot-XXXXXX")
  cp -a --reflink=auto "$ROOT/data" "$SNAP/data"
  J=$SNAP/data/events.jsonl
  if [ -s "$J" ] && [ "$(tail -c 1 "$J" | od -An -tx1 | tr -d ' \n')" != "0a" ]; then
    truncate -s "$(( $(stat -c %s "$J") - $(tail -n 1 "$J" | wc -c) ))" "$J"
    echo "journal snapshot: dropped an incomplete last line"
  fi
  sync "$SNAP/data" "$SNAP/data"/* 2>/dev/null || sync
  tar -czf "$DIR/umbrella-$STAMP-data.tar.gz.tmp" -C "$SNAP" data
  mv "$DIR/umbrella-$STAMP-data.tar.gz.tmp" "$DIR/umbrella-$STAMP-data.tar.gz"
fi

find "$DIR" -maxdepth 1 -name 'umbrella-*' -mtime +"$KEEP_DAYS" -delete
# Clear our own failure marker lines (a restore-test failure stays until someone looks at it).
if [ -f "$DIR/LAST_FAILED" ]; then
  sed -i '/ umbrella-backup\.service failed/d' "$DIR/LAST_FAILED"
  [ -s "$DIR/LAST_FAILED" ] || rm -f "$DIR/LAST_FAILED"
fi
echo "backup ok: $(find "$DIR" -maxdepth 1 -name "umbrella-$STAMP*" | wc -l) files, $(du -sh "$DIR" | cut -f1) total"
