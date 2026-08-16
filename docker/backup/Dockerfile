# Nightly pg_dump sidecar.
#
# ARCHITECTURE 8 names prodrigestivill/postgres-backup-local. That image does not run
# here at all - every binary in it, from its own /init.sh down to /bin/sh, exits with
# "exec format error", including when pulled by its amd64 digest, while debian and
# postgres:16-alpine on the same daemon are fine. Rather than ship a backup path that
# has never once executed, this builds the same job from the postgres image itself.
#
# It is also the better base regardless of that. pg_dump refuses to dump from a server
# newer than itself, so the dumper's version has to track the server's; deriving from
# `postgres:16` makes that a single tag both services share instead of two versions
# that drift until a major upgrade fails at 3am.

FROM postgres:16-alpine

COPY backup.sh /usr/local/bin/backup.sh
COPY healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/healthcheck.sh

# Checks the artefact, not the process. See healthcheck.sh.
HEALTHCHECK --interval=5m --timeout=10s --start-period=2m --retries=3 \
    CMD ["/usr/local/bin/healthcheck.sh"]

ENTRYPOINT ["/usr/local/bin/backup.sh"]
