#!/usr/bin/env bash
# Proves the latest nightly dump can actually be restored: pg_restore into a throwaway database
# umbrella_restore_test, count rows in every table, drop the database. The live database is never touched.
# Run by umbrella-restore-test.timer (monthly) or by hand: sudo bash /opt/umbrella/app/deploy/restore-test.sh [file.dump]
set -euo pipefail

DIR=${UMBRELLA_ROOT:-/opt/umbrella}/backups
TEST_DB=umbrella_restore_test
DUMP=${1:-}
if [ -z "$DUMP" ]; then
  # shellcheck disable=SC2012
  DUMP=$(ls -1t "$DIR"/umbrella-*.dump 2>/dev/null | head -n 1 || true)
fi
[ -n "$DUMP" ] && [ -s "$DUMP" ] || { echo "no dump found in $DIR" >&2; exit 1; }
if ! id postgres >/dev/null 2>&1; then echo "no local PostgreSQL — nothing to test" >&2; exit 1; fi

as_pg() { sudo -u postgres "$@"; }
drop() { as_pg dropdb --if-exists "$TEST_DB" >/dev/null 2>&1 || true; }
trap drop EXIT

echo "restore test: $DUMP"
drop
as_pg createdb "$TEST_DB"
# The dump is root-only; feed it on stdin so the postgres user does not need to read the file.
as_pg pg_restore --no-owner --no-acl --exit-on-error -d "$TEST_DB" < "$DUMP"

tables=$(as_pg psql -d "$TEST_DB" -v ON_ERROR_STOP=1 -qtA -c \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")
[ -n "$tables" ] || { echo "restore test FAILED: no tables restored" >&2; exit 1; }
for required in campaigns clicks users; do
  grep -qx "$required" <<<"$tables" || { echo "restore test FAILED: table $required missing" >&2; exit 1; }
done
total=0
for t in $tables; do
  n=$(as_pg psql -d "$TEST_DB" -v ON_ERROR_STOP=1 -qtA -c "SELECT count(*) FROM public.\"$t\"")
  printf '  %-20s %s\n' "$t" "$n"
  total=$((total + n))
done
echo "restore test ok: $(wc -l <<<"$tables") tables, $total rows, dump $(du -h "$DUMP" | cut -f1)"
