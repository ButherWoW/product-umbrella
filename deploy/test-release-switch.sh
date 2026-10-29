#!/usr/bin/env bash
# Simulates deploy/release.sh on a fake /opt/umbrella tree: first run on the current server layout
# (plain app directory), later runs, a release that fails the health check (rollback), pruning, dumps,
# a re-run of the same commit and a fresh server. systemctl, npm, curl, sudo, journalctl and sleep are stubs.
# Needs root (release.sh chowns the release): CI runs `sudo bash deploy/test-release-switch.sh`;
# locally: docker run --rm -v "$PWD":/w -w /w ubuntu:24.04 bash deploy/test-release-switch.sh
# Stub bodies are single-quoted on purpose: they expand when the stub runs.
# shellcheck disable=SC2016
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
RELEASE_SH=$HERE/release.sh
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
STUBS=$WORK/stubs
LOG=$WORK/calls.log
mkdir -p "$STUBS"
: > "$LOG"

stub() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$STUBS/$1"; chmod +x "$STUBS/$1"; }
stub systemctl 'echo "systemctl $*" >> "$CALLS"'
stub journalctl 'echo "journalctl $*" >> "$CALLS"; echo "fake journal postgresql://umbrella:secret@127.0.0.1/umbrella"'
stub sleep ':'
stub npm 'echo "npm $* in $PWD" >> "$CALLS"; mkdir -p node_modules/dep'
# /health of the live release = the release's health.json (missing file -> connection refused)
stub curl 'f="$UMBRELLA_ROOT/app/health.json"; [ -f "$f" ] || exit 7; cat "$f"'
# only `sudo -u postgres pg_dump -Fc umbrella` is used
stub sudo 'echo "sudo $*" >> "$CALLS"; echo "FAKE DUMP"'
export PATH="$STUBS:$PATH" CALLS=$LOG HEALTH_TRIES=3

pass=0
ok() { pass=$((pass + 1)); echo "  ok - $*"; }
fail() { echo "  FAIL - $*" >&2; echo "--- calls:" >&2; cat "$LOG" >&2; exit 1; }
expect_link() { # $1 = expected release name
  [ -L "$ROOT/app" ] || fail "app is not a symlink"
  [ "$(readlink "$ROOT/app")" = "releases/$1" ] || fail "app -> $(readlink "$ROOT/app"), expected releases/$1"
  [ -f "$ROOT/app/src/server.js" ] || fail "app/src/server.js not reachable through the symlink"
  ok "app -> releases/$1"
}
# Same as the workflow's "Sync app" step: rsync the checkout into releases/<sha>.
sync_release() { # $1 = sha, $2 = health json ('' = service does not come up)
  mkdir -p "$ROOT/releases/$1/src" "$ROOT/releases/$1/deploy"
  echo "// $1" > "$ROOT/releases/$1/src/server.js"
  cp "$HERE/umbrella.service" "$ROOT/releases/$1/deploy/"
  echo '{"lockfileVersion":3}' > "$ROOT/releases/$1/package-lock.json"
  if [ -n "$2" ]; then echo "$2" > "$ROOT/releases/$1/health.json"; fi
}
release() { UMBRELLA_ROOT=$ROOT SYSTEMD_DIR=$ROOT/systemd bash "$RELEASE_SH" "$@"; }
deploy() { release adopt && release build "$1" && release dump "$1" && release activate "$1" && release prune; }
GOOD='{"ok":true,"storage":"postgres","geo":true}'
JSONL='{"ok":true,"storage":"jsonl","geo":true}'

new_server() { # $1 = name; current production layout: plain app directory with node_modules, env with DATABASE_URL
  ROOT=$WORK/$1
  mkdir -p "$ROOT/app/src" "$ROOT/app/node_modules/x" "$ROOT/app/deploy" "$ROOT/data" "$ROOT/backups" "$ROOT/systemd"
  echo "// old" > "$ROOT/app/src/server.js"
  echo "$GOOD" > "$ROOT/app/health.json"
  printf 'PORT=4110\nDATABASE_URL=postgresql://umbrella:x@127.0.0.1:5432/umbrella\nREQUIRE_POSTGRES=1\n' > "$ROOT/.env"
  export UMBRELLA_ROOT=$ROOT
}

echo "# first deploy on the existing server"
new_server existing
sync_release aaa "$GOOD"
release adopt
expect_link initial
grep -q old "$ROOT/releases/initial/src/server.js" || fail "old code not kept in releases/initial"
[ -d "$ROOT/releases/initial/node_modules/x" ] || fail "old node_modules not kept"
ok "old app directory moved to releases/initial with node_modules"
release adopt
expect_link initial
ok "adopt is idempotent"
release build aaa && release dump aaa && release activate aaa && release prune
expect_link aaa
[ -f "$ROOT/systemd/umbrella.service" ] || fail "unit not installed"
grep -q 'systemctl restart umbrella' "$LOG" || fail "service not restarted"
[ -s "$ROOT/backups/pre-deploy-aaa.dump" ] || fail "pre-deploy dump missing"
[ -d "$ROOT/releases/initial" ] || fail "initial release pruned too early"
ok "first deploy: unit installed, dump written, restarted, initial kept"
[ -z "$(find "$ROOT" -name 'app.next')" ] || fail "temporary symlink left behind"

echo "# second deploy"
sync_release bbb "$GOOD"
deploy bbb
expect_link bbb

echo "# broken release: comes up on JSONL although DATABASE_URL is set -> rollback"
sync_release ccc "$JSONL"
: > "$LOG"
if deploy ccc; then fail "deploy of a broken release succeeded"; fi
expect_link bbb
[ "$(grep -c 'systemctl restart umbrella' "$LOG")" = 2 ] || fail "expected restart of ccc and of bbb"
ok "rolled back to bbb and restarted"

echo "# broken release: service does not answer -> rollback"
sync_release ddd ""
if deploy ddd; then fail "deploy of a dead release succeeded"; fi
expect_link bbb

echo "# more deploys, pruning keeps 3 activated releases"
sync_release eee "$GOOD"; deploy eee
sync_release fff "$GOOD"; deploy fff
expect_link fff
left=$(find "$ROOT/releases" -mindepth 1 -maxdepth 1 -printf '%f\n' | sort | tr '\n' ' ')
[ "$left" = "bbb eee fff " ] || fail "releases left: $left (expected bbb eee fff)"
ok "pruned to: $left"

echo "# pre-deploy dumps: keep the newest 5"
for i in 1 2 3 4 5 6 7; do release dump "d$i"; touch -d "-$((10 - i)) seconds" "$ROOT/backups/pre-deploy-d$i.dump"; done
release dump fff
n=$(find "$ROOT/backups" -name 'pre-deploy-*.dump' | wc -l)
[ "$n" = 5 ] || fail "$n pre-deploy dumps kept, expected 5"
[ -f "$ROOT/backups/pre-deploy-fff.dump" ] || fail "newest dump removed"
ok "5 dumps kept"

echo "# re-run of the live commit keeps node_modules (no npm ci under the running service)"
: > "$LOG"
sync_release fff "$GOOD"
deploy fff
expect_link fff
if grep -q '^npm ci' "$LOG"; then fail "npm ci ran again for an unchanged lockfile"; fi
ok "no npm ci on re-run"

echo "# no DATABASE_URL (JSONL host): no dump, storage not required"
sed -i '/^DATABASE_URL=/d; /^REQUIRE_POSTGRES=/d' "$ROOT/.env"
sync_release ggg "$JSONL"
deploy ggg
expect_link ggg
[ ! -f "$ROOT/backups/pre-deploy-ggg.dump" ] || fail "dump without DATABASE_URL"
ok "JSONL host deploys without dump"

echo "# fresh server (no app directory yet)"
new_server fresh
rm -rf "$ROOT/app"
sync_release hhh ""
if deploy hhh; then fail "dead release on a fresh server succeeded"; fi
[ "$(readlink "$ROOT/app")" = releases/hhh ] || fail "fresh server: nothing to roll back to, app should stay on hhh"
ok "fresh server failure reported (no previous release)"
sync_release iii "$GOOD"
deploy iii
expect_link iii

echo "# bad arguments"
if release build '../etc' 2>/dev/null; then fail "path traversal accepted"; fi
if release activate 2>/dev/null; then fail "missing sha accepted"; fi
ok "bad release names rejected"

echo "release switch simulation: $pass checks passed"
