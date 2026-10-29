#!/usr/bin/env bash
# Called by umbrella-failed@<unit>.service (OnFailure= of the backup and restore-test units).
# No external service: appends a line to backups/LAST_FAILED and logs an error to the journal.
# Backup lines are cleared by the next successful backup; restore-test lines stay until removed by hand.
# Check: cat /opt/umbrella/backups/LAST_FAILED; journalctl -p err -t umbrella-failed
set -euo pipefail
unit=${1:-unknown}
dir=${UMBRELLA_ROOT:-/opt/umbrella}/backups
mkdir -p "$dir"
line="$(date -u +%Y-%m-%dT%H:%M:%SZ) $unit failed, see: journalctl -u $unit"
echo "$line" >> "$dir/LAST_FAILED"
logger -p user.err -t umbrella-failed "$line" 2>/dev/null || echo "<3>$line"
