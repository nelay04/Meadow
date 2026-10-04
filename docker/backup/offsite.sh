#!/bin/sh
# Push one verified dump to object storage, encrypted, for the case the host is gone.
#
# ARCHITECTURE 8 has no WAL archiving and no PITR, so a dump is the whole recovery
# story; `docs/REVIEW-2026-10.md` finding 15 is that the dumps were sitting on the same
# filesystem as the database they recover, which protects against a bad migration and
# against nothing physical.
#
# Two decisions here are the point of it, and both are about what an attacker on this
# host can do.
#
# The dump is encrypted to an age *public* key. Only the public half is on the box, so
# this container can seal a backup and cannot open one, and a copy of the private key
# never has to exist here to be stolen. Keep that private key off the host, somewhere
# you will still have it the day the host is gone, because without it these files are
# noise.
#
# Retention is the bucket's job, through a lifecycle rule, not this script's. The token
# this runs with should be write-only: ransomware that reaches the host can then
# encrypt the local dumps and still not reach the copies. A token that could prune
# could also wipe, which would spend the whole exercise.
#
# Called by backup.sh after a dump is verified, and by hand for a pre-deploy dump:
#   docker compose --env-file .env.prod run --rm --entrypoint \
#     /usr/local/bin/offsite.sh backup /backups/meadow-predeploy-....dump
set -eu

DIR="${BACKUP_DIR:-/backups}"
MARKER="${DIR}/.last-offsite"

log() {
    echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') offsite: $*"
}

target="${1:-}"
if [ -z "${target}" ] || [ ! -f "${target}" ]; then
    log "FAILED: no such dump: ${target:-<none>}"
    exit 1
fi

# Unconfigured is a supported state, not an error. The stack has to come up on a box
# with no bucket yet, and a dev stack has no business shipping dumps anywhere.
if [ -z "${BACKUP_R2_BUCKET:-}" ]; then
    log "no BACKUP_R2_BUCKET, keeping $(basename "${target}") on this host only"
    exit 0
fi

# Refused rather than sent in the clear. These dumps hold every address and password
# hash in the database, and "the bucket is private" is not the same promise.
if [ -z "${BACKUP_AGE_RECIPIENT:-}" ]; then
    log "FAILED: BACKUP_R2_BUCKET is set but BACKUP_AGE_RECIPIENT is not."
    log "        Refusing to upload an unencrypted dump. Set the age public key."
    exit 1
fi

for var in BACKUP_R2_ACCOUNT_ID BACKUP_R2_ACCESS_KEY_ID BACKUP_R2_SECRET_ACCESS_KEY; do
    eval "value=\${${var}:-}"
    if [ -z "${value}" ]; then
        log "FAILED: ${var} is not set"
        exit 1
    fi
done

name="$(basename "${target}").age"
work="$(mktemp -d)"
sealed="${work}/${name}"
# shellcheck disable=SC2064 - the path is wanted as it is now, not at trap time.
trap "rm -rf '${work}'" EXIT INT TERM

if ! age --recipient "${BACKUP_AGE_RECIPIENT}" --output "${sealed}" "${target}"; then
    log "FAILED: could not encrypt $(basename "${target}")"
    exit 1
fi

# rclone takes its whole remote from the environment, so the image ships no config file
# and no secret is written to disk. `no_check_bucket` is what lets a write-only token
# work: without it rclone probes the bucket first and a token with no read is refused.
# Provider and endpoint are overridable so this path can be exercised against a local
# S3 server before it is trusted with real data; the defaults are R2's.
RCLONE_CONFIG_R2_TYPE=s3
RCLONE_CONFIG_R2_PROVIDER="${BACKUP_S3_PROVIDER:-Cloudflare}"
RCLONE_CONFIG_R2_ENDPOINT="${BACKUP_S3_ENDPOINT:-https://${BACKUP_R2_ACCOUNT_ID}.r2.cloudflarestorage.com}"
RCLONE_CONFIG_R2_ACCESS_KEY_ID="${BACKUP_R2_ACCESS_KEY_ID}"
RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="${BACKUP_R2_SECRET_ACCESS_KEY}"
RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true
export RCLONE_CONFIG_R2_TYPE RCLONE_CONFIG_R2_PROVIDER RCLONE_CONFIG_R2_ENDPOINT
export RCLONE_CONFIG_R2_ACCESS_KEY_ID RCLONE_CONFIG_R2_SECRET_ACCESS_KEY
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET

prefix="${BACKUP_R2_PREFIX:-meadow}"
destination="R2:${BACKUP_R2_BUCKET}/${prefix}/${name}"

log "uploading ${name}, $(wc -c < "${sealed}") bytes encrypted"
if ! rclone copyto --retries 3 --low-level-retries 3 "${sealed}" "${destination}"; then
    log "FAILED: upload of ${name} did not complete"
    exit 1
fi

# The marker is what the healthcheck reads. A dump that was written locally and never
# left is the same silent failure as a backup job producing nothing, so it has to show
# up somewhere a check can see it rather than only in the log.
date -u '+%Y-%m-%dT%H:%M:%SZ' > "${MARKER}"
log "uploaded ${name}"
