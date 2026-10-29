#!/usr/bin/env bash
# Creates Umbrella's own PostgreSQL role and database (idempotent) and prints DATABASE_URL.
# Other projects on this server keep their databases; nobody but the umbrella role may connect to this one.
# Prints nothing if there is no local PostgreSQL — the tracker then stores data in its own JSONL directory.
set -euo pipefail

PWFILE=/opt/umbrella/.db_password
if ! command -v psql >/dev/null 2>&1 || ! id postgres >/dev/null 2>&1; then
  echo "no local PostgreSQL — Umbrella will use its own JSONL storage" >&2
  exit 0
fi
if [ ! -s "$PWFILE" ]; then
  (umask 077; openssl rand -hex 24 > "$PWFILE")
fi
PW=$(cat "$PWFILE")
as_pg() { sudo -u postgres psql -v ON_ERROR_STOP=1 -qtA "$@"; }

if [ "$(as_pg -c "SELECT 1 FROM pg_roles WHERE rolname = 'umbrella'")" != "1" ]; then
  as_pg -c "CREATE ROLE umbrella LOGIN PASSWORD '$PW'"
else
  as_pg -c "ALTER ROLE umbrella LOGIN PASSWORD '$PW'"
fi
if [ "$(as_pg -c "SELECT 1 FROM pg_database WHERE datname = 'umbrella'")" != "1" ]; then
  as_pg -c "CREATE DATABASE umbrella OWNER umbrella"
fi
as_pg -c "REVOKE ALL ON DATABASE umbrella FROM PUBLIC"
as_pg -c "GRANT CONNECT, TEMP ON DATABASE umbrella TO umbrella"

echo "DATABASE_URL=postgresql://umbrella:${PW}@127.0.0.1:5432/umbrella"
