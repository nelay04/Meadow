#!/usr/bin/env bash
# Bring up an API instance to point the load harness at.
#
# Deliberately NOT the dev stack on 8012. Two reasons, and both would otherwise make
# the numbers wrong:
#
#   * Rate limiting. The dev API enforces the real ARCHITECTURE 7 limits - 5 logins a
#     minute, 3 registrations an hour, 30 ws-tokens a minute. A load generator trips
#     every one of them in the first second, so the run would measure the rate limiter.
#     Those limits are correct and are asserted by `tests/test_auth.py`; they are
#     turned off here because this harness is measuring what is behind them.
#   * Its database. A load run creates thousands of accounts, boards and update rows.
#     That belongs in a scratch database, not in the one being developed against.
#
# So: same code, same Postgres and Redis servers, its own database, its own Redis db,
# its own port.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${MEADOW_LOAD_PORT:-8099}"
PGHOST="${MEADOW_LOAD_PGHOST:-localhost}"
PGPORT="${MEADOW_LOAD_PGPORT:-5435}"
DB="${MEADOW_LOAD_DB:-meadow_load}"

export MEADOW_DATABASE_URL="postgresql+asyncpg://meadow:meadow@${PGHOST}:${PGPORT}/${DB}"
export MEADOW_REDIS_URL="${MEADOW_LOAD_REDIS:-redis://localhost:6382/2}"
export MEADOW_JWT_SECRET="load-test-secret-not-used-anywhere-real-0123456789"
export MEADOW_RATE_LIMIT_ENABLED="false"
# The room cap, left at the real default unless a capacity sweep raises it. Measuring
# the default tells you what the setting says; raising it is the only way to find out
# what the room can actually hold. `loadtest/target.sh start` keeps the honest value,
# and the capacity suite starts its own target with MEADOW_LOAD_ROOM_CAP set high.
export MEADOW_MAX_CLIENTS_PER_ROOM="${MEADOW_LOAD_ROOM_CAP:-50}"
# No mail, so registration opens the account immediately instead of waiting on a link.
export MEADOW_MAIL_PROVIDER="smtp"
export MEADOW_SMTP_HOST=""
export MEADOW_SMTP_FROM=""

PIDFILE="/tmp/meadow-loadtarget-${PORT}.pid"
LOGFILE="/tmp/meadow-loadtarget-${PORT}.log"

case "${1:-start}" in
  start)
    if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
      echo "already running on :${PORT} (pid $(cat "$PIDFILE"))"; exit 0
    fi
    echo "recreating ${DB}"
    # Terminate anything still attached first. A previous run that was killed rather
    # than stopped leaves backends behind, and Postgres refuses to drop a database
    # that has sessions on it - which used to fail the whole script under `set -e`
    # before the server was ever started.
    PGPASSWORD=meadow psql -h "$PGHOST" -p "$PGPORT" -U meadow -d postgres -q \
      -c "select pg_terminate_backend(pid) from pg_stat_activity
          where datname = '${DB}' and pid <> pg_backend_pid()" >/dev/null
    PGPASSWORD=meadow psql -h "$PGHOST" -p "$PGPORT" -U meadow -d postgres -q \
      -c "drop database if exists ${DB}" -c "create database ${DB}"
    echo "migrating"
    (cd "$HERE" && .venv/bin/alembic upgrade head >/dev/null)
    echo "starting uvicorn on :${PORT}"
    # setsid + the pid of uvicorn itself, not of a wrapping subshell: `stop` has to
    # be able to kill the server, and an earlier version recorded the subshell's pid
    # and left the server running after a "stop" that reported success.
    cd "$HERE"
    setsid .venv/bin/uvicorn app.main:app \
        --host 127.0.0.1 --port "$PORT" --workers 1 --log-level warning \
        > "$LOGFILE" 2>&1 < /dev/null &
    echo $! > "$PIDFILE"
    for _ in $(seq 1 30); do
      if curl -sf "http://127.0.0.1:${PORT}/healthz" >/dev/null; then
        echo "up on http://127.0.0.1:${PORT}"; exit 0
      fi
      sleep 1
    done
    echo "failed to come up; see $LOGFILE" >&2; tail -20 "$LOGFILE" >&2; exit 1
    ;;
  stop)
    if [ -f "$PIDFILE" ]; then kill "$(cat "$PIDFILE")" 2>/dev/null || true; rm -f "$PIDFILE"; fi
    echo "stopped"
    ;;
  *)
    echo "usage: $0 {start|stop}" >&2; exit 2
    ;;
esac
