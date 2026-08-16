#!/bin/sh
# Unhealthy if the newest verified dump is older than the interval plus a grace period.
#
# Checking that the process is alive would be worthless: the failure mode of a backup
# job is not crashing, it is running happily and producing nothing.
set -eu

DIR="${BACKUP_DIR:-/backups}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
# One extra interval of slack, so a single failed run reports a warning window rather
# than flapping the container between healthy and not.
STALE_MINUTES=$(( (INTERVAL * 2) / 60 ))

newest=$(find "${DIR}" -maxdepth 1 -name 'meadow-*.dump' -type f -mmin "-${STALE_MINUTES}" -print -quit 2>/dev/null || true)

if [ -z "${newest}" ]; then
    echo "no verified dump newer than ${STALE_MINUTES} minutes in ${DIR}"
    exit 1
fi

echo "ok: $(basename "${newest}")"
