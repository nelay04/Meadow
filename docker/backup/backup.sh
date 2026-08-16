#!/bin/sh
# Nightly pg_dump with retention. ARCHITECTURE 8: no WAL archiving and no PITR, so
# this is the whole recovery story and it has to actually work.
#
# A loop rather than cron. crond wants root and logs to its own file, and the one
# thing you want from a backup job is to be able to read what it did in `docker logs`.
set -eu

DIR="${BACKUP_DIR:-/backups}"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-7}"
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"

log() {
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') backup: $*"
}

run_once() {
    stamp=$(date -u '+%Y%m%dT%H%M%SZ')
    target="${DIR}/meadow-${stamp}.dump"
    partial="${target}.partial"

    log "dumping ${PGDATABASE} to $(basename "${target}")"

    # Custom format: compressed, and pg_restore can read a table list out of it, which
    # is what makes the verify step below possible.
    if ! pg_dump --format=custom --compress=6 --file="${partial}"; then
        log "FAILED: pg_dump exited non-zero"
        rm -f "${partial}"
        return 1
    fi

    # A dump that cannot be read back is not a backup. pg_dump can exit 0 having
    # written a file the disk then failed to flush, and the usual way that is found
    # out is during a restore, on the worst day of the year.
    if ! pg_restore --list "${partial}" > /dev/null 2>&1; then
        log "FAILED: dump is not readable by pg_restore, discarding"
        rm -f "${partial}"
        return 1
    fi

    # Rename last, so a crashed run never leaves a half-written file that looks like a
    # usable backup and never becomes the newest one the healthcheck is happy about.
    mv "${partial}" "${target}"
    log "wrote $(basename "${target}"), $(wc -c < "${target}") bytes, verified"

    # Retention runs only after a verified success. Pruning first would mean a run of
    # failures quietly eats the good backups it cannot replace.
    deleted=$(find "${DIR}" -maxdepth 1 -name 'meadow-*.dump' -type f -mtime "+${KEEP_DAYS}" -print -delete | wc -l)
    [ "${deleted}" -gt 0 ] && log "pruned ${deleted} dump(s) older than ${KEEP_DAYS} days"

    return 0
}

mkdir -p "${DIR}"

# First dump immediately. A backup job whose first run is tomorrow means the first
# deploy spends a day not knowing whether backups work at all, and the container's
# healthcheck has nothing to look at until then.
log "starting: interval ${INTERVAL}s, keeping ${KEEP_DAYS} days, target ${DIR}"

while true; do
    run_once || log "run failed, will retry at the next interval"
    sleep "${INTERVAL}"
done
