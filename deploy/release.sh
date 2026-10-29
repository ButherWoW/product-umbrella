#!/usr/bin/env bash
# Release-based deploy for Umbrella on the server (called by .github/workflows/deploy.yml over SSH).
#
# Layout:
#   /opt/umbrella/releases/<sha>/   one directory per deployed commit (code + node_modules)
#   /opt/umbrella/app -> releases/<sha>   symlink to the live release; systemd WorkingDirectory points here
#   /opt/umbrella/backups/pre-deploy-<sha>.dump   PostgreSQL dump taken right before migrations
#
# Subcommands:
#   adopt              first run: move a plain /opt/umbrella/app directory to releases/initial and replace it
#                      with a symlink (idempotent; does nothing when app is already a symlink)
#   build <sha>        npm ci in releases/<sha>, files readable by the service user
#   dump <sha>         pg_dump -Fc of the umbrella database before migrations (keeps the last 5)
#   activate <sha>     install the systemd unit, switch the symlink, restart, health check;
#                      on failure switch back to the previous release, restart and exit 1
#   prune              keep the 3 newest activated releases (never the live one)
#
# Migrations are forward-only: rolling the code back after a schema change runs old code on the new schema.
# If that breaks, restore the database from backups/pre-deploy-<sha>.dump (see README «Бэкапы»).
#
# Everything is overridable for deploy/test-release-switch.sh: UMBRELLA_ROOT, SYSTEMD_DIR, HEALTH_URL,
# HEALTH_TRIES, KEEP_RELEASES, KEEP_DUMPS.
set -euo pipefail

ROOT=${UMBRELLA_ROOT:-/opt/umbrella}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
HEALTH_URL=${HEALTH_URL:-http://127.0.0.1:4110/health}
HEALTH_TRIES=${HEALTH_TRIES:-20}
KEEP_RELEASES=${KEEP_RELEASES:-3}
KEEP_DUMPS=${KEEP_DUMPS:-5}
RELEASES=$ROOT/releases
APP=$ROOT/app
# .deployed-at holds the activation time in nanoseconds (prune order). Files the workflow's rsync must not delete (it passes --exclude for both).
MARKER=.deployed-at
BUILT=.built-lock

log() { echo "[release] $*"; }
die() { echo "[release] ERROR: $*" >&2; exit 1; }

valid_name() { [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]] && [ "$1" != . ] && [ "$1" != .. ]; }

# Atomically point $APP at $1 (a path relative to $ROOT, e.g. releases/abc): rename(2) of a new symlink over the old one.
point_app_to() {
  ln -sfn "$1" "$APP.next"
  mv -Tf "$APP.next" "$APP"
}

# Release name the app symlink points to, or empty.
current_release() {
  [ -L "$APP" ] || return 0
  basename "$(readlink "$APP")"
}

cmd_adopt() {
  mkdir -p "$RELEASES"
  rm -f "$APP.next"
  if [ -L "$APP" ]; then
    log "app is already a symlink -> $(readlink "$APP")"
    return 0
  fi
  if [ ! -e "$APP" ]; then
    log "no existing app directory (fresh server)"
    return 0
  fi
  [ -d "$APP" ] || die "$APP exists but is neither a directory nor a symlink"
  local name=initial
  [ -e "$RELEASES/$name" ] && name="initial-$(date -u +%Y%m%d%H%M%S)"
  # Same filesystem, so this is a rename: the running service keeps its open files and working directory.
  mv -T "$APP" "$RELEASES/$name"
  point_app_to "releases/$name"
  date -u +%s%N > "$RELEASES/$name/$MARKER"
  log "moved the existing app directory to releases/$name, app -> releases/$name"
}

cmd_build() {
  local sha=$1 dir
  dir=$RELEASES/$sha
  [ -d "$dir" ] || die "release $dir not found (rsync first)"
  # A re-run of the same commit (it may be the live release) keeps node_modules if the lockfile is unchanged,
  # so the running service never loses its modules mid-flight.
  if [ -d "$dir/node_modules" ] && [ -f "$dir/$BUILT" ] && cmp -s "$dir/package-lock.json" "$dir/$BUILT"; then
    log "releases/$sha already built for this package-lock.json"
  else
    rm -f "$dir/$BUILT"
    (cd "$dir" && umask 022 && npm ci --omit=dev --no-audit --no-fund --loglevel=error)
    cp "$dir/package-lock.json" "$dir/$BUILT"
  fi
  chown -R root:root "$dir"
  # Root may have a strict umask on this host; the service user must be able to read the code and node_modules.
  chmod -R a+rX,go-w "$dir"
  log "built releases/$sha"
}

cmd_dump() {
  local sha=$1 dir=$ROOT/backups out
  if ! grep -q '^DATABASE_URL=' "$ROOT/.env" 2>/dev/null; then
    log "no DATABASE_URL in $ROOT/.env, pre-deploy dump skipped"
    return 0
  fi
  mkdir -p "$dir"
  out=$dir/pre-deploy-$sha.dump
  # The redirect is done by root on purpose: the dump file is root-only.
  # shellcheck disable=SC2024
  (umask 077; sudo -u postgres pg_dump -Fc umbrella > "$out.tmp")
  mv -f "$out.tmp" "$out"
  log "pre-deploy dump: $out ($(du -h "$out" | cut -f1))"
  # Keep the newest $KEEP_DUMPS pre-deploy dumps (names have no spaces: <sha>.dump).
  # shellcheck disable=SC2012
  ls -1t "$dir"/pre-deploy-*.dump 2>/dev/null | tail -n +"$((KEEP_DUMPS + 1))" | while read -r old; do
    rm -f -- "$old"; log "removed old dump $(basename "$old")"
  done
}

healthy() {
  local body
  body=$(curl -sf --max-time 3 "$HEALTH_URL" 2>/dev/null) || return 1
  printf '%s' "$body" | grep -q '"ok":true' || return 1
  if grep -q '^DATABASE_URL=' "$ROOT/.env" 2>/dev/null; then
    printf '%s' "$body" | grep -q '"storage":"postgres"' || return 1
  fi
  return 0
}

restart_and_check() {
  systemctl restart umbrella || return 1
  local i
  for i in $(seq 1 "$HEALTH_TRIES"); do
    sleep 1
    if healthy; then log "umbrella healthy (${i}s)"; return 0; fi
  done
  return 1
}

cmd_activate() {
  local sha=$1 new=$RELEASES/$1 prev
  [ -d "$new/node_modules" ] || die "releases/$sha is not built"
  prev=$(current_release)

  install -m 644 "$new/deploy/umbrella.service" "$SYSTEMD_DIR/umbrella.service"
  systemctl daemon-reload
  systemctl enable --quiet umbrella

  point_app_to "releases/$sha"
  log "app -> releases/$sha (previous: ${prev:-none})"
  if restart_and_check; then
    date -u +%s%N > "$new/$MARKER"
    return 0
  fi

  echo "::error::umbrella release $sha failed the health check (/health must be ok with storage postgres)"
  journalctl -u umbrella -n 40 --no-pager 2>/dev/null | sed -E 's#postgresql://[^@ ]*@#postgresql://***@#g' || true
  if [ -n "$prev" ] && [ "$prev" != "$sha" ] && [ -d "$RELEASES/$prev" ]; then
    point_app_to "releases/$prev"
    log "rolled back: app -> releases/$prev"
    if restart_and_check; then
      log "previous release $prev is up again"
    else
      echo "::error::previous release $prev is not healthy either"
    fi
  else
    echo "::error::no previous release to roll back to"
  fi
  exit 1
}

cmd_prune() {
  local live keep=0 name
  live=$(current_release)
  mkdir -p "$RELEASES"
  # Newest activation first; directories that were never activated (failed builds) sort last.
  for name in $(
    for d in "$RELEASES"/*/; do
      [ -d "$d" ] || continue
      n=$(basename "$d")
      if [ -s "$d$MARKER" ]; then echo "$(head -c 32 "$d$MARKER" | tr -cd 0-9) $n"; else echo "0 $n"; fi
    done | sort -rn | cut -d' ' -f2
  ); do
    if [ "$name" = "$live" ]; then keep=$((keep + 1)); continue; fi
    if [ "$keep" -lt "$KEEP_RELEASES" ] && [ -e "$RELEASES/$name/$MARKER" ]; then keep=$((keep + 1)); continue; fi
    rm -rf -- "${RELEASES:?}/$name"
    log "removed old release $name"
  done
}

main() {
  local cmd=${1:-}
  shift || true
  case "$cmd" in
    adopt) cmd_adopt ;;
    prune) cmd_prune ;;
    build|dump|activate)
      if [ $# -ne 1 ] || ! valid_name "$1"; then die "usage: $0 $cmd <sha>"; fi
      "cmd_$cmd" "$1" ;;
    *) die "usage: $0 adopt | build <sha> | dump <sha> | activate <sha> | prune" ;;
  esac
}

main "$@"
