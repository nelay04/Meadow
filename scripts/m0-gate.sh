#!/usr/bin/env bash
# Full M0 gate. Starts the API, runs every phase, and restarts the server in the
# middle so persistence is proven against a cold process rather than a warm cache.
#
#   ./scripts/m0-gate.sh
#
# Assumes postgres and redis are already up: docker compose -f docker-compose.local.yml up -d
set -euo pipefail

cd "$(dirname "$0")/.."

# .env is gitignored, so a fresh clone and CI both run without one. Source it when it
# is there, and otherwise fall back to the same defaults the compose file and vite use
# rather than dying on an unbound variable three lines later.
#
# The fallback is announced rather than silent. Defaults that quietly differ from the
# ports and credentials the rest of the stack is using produce a gate that connects to
# the wrong database and passes, which is worse than one that fails.
if [ -f ./.env ]; then
  set -a && . ./.env && set +a
else
  if [ -t 2 ]; then bold=$'\033[1;33m'; reset=$'\033[0m'; else bold=""; reset=""; fi
  {
    echo ""
    echo "${bold}WARNING: no .env at the repo root.${reset}"
    echo "${bold}Falling back to built-in defaults: WEB_PORT=3012,${reset}"
    echo "${bold}and the database and redis URLs compiled into app/config.py.${reset}"
    echo "${bold}If your postgres or redis is anywhere else, this run will not reach it.${reset}"
    echo "${bold}Copy .env.example to .env to make the settings explicit.${reset}"
    echo ""
  } >&2
fi
# A port of this run's own, not the one in .env.
#
# The gate starts an API, kills it and starts it again, so it cannot share a port with
# anything: the local stack publishes API_PORT for the containerised api, and a gate
# that took the same number could only be run with the stack down. Same convention the
# e2e scripts already use for theirs. Override with GATE_API_PORT if 8013 is taken.
API_PORT="${GATE_API_PORT:-8013}"
: "${WEB_PORT:=3012}"
export API_PORT WEB_PORT

# The gate registers several actors per run, and registration is capped at 3 per hour
# per IP. Correct in production, and it means the gate can only be run three times a
# day from one machine. The limiter is covered by tests/test_auth.py; none of the
# phases below are about it.
export MEADOW_RATE_LIMIT_ENABLED=false

API_DIR="services/api"
LOG="$(mktemp -t meadow-m0-api.XXXXXX.log)"
SERVER_PID=""

require_free_port() {
  # The readiness loop below cannot tell our server from someone else's. A dev API
  # left running on the same port answers /healthz instantly, the gate proceeds
  # against it, and every phase then measures code that may not be the code in the
  # tree. Refuse rather than pass for the wrong reason.
  if curl -sf "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; then
    echo "something is already serving :${API_PORT}. Stop it first; the gate must run" >&2
    echo "against a server it started itself." >&2
    exit 1
  fi
}

start_api() {
  # exec so the subshell is replaced by python and $! is the real server PID.
  # Without it the trap kills the wrapper and leaves uvicorn holding the port.
  (cd "$API_DIR" && exec .venv/bin/python -m uvicorn app.main:app \
    --host 127.0.0.1 --port "${API_PORT}" --log-level warning >>"$LOG" 2>&1) &
  SERVER_PID=$!
  for _ in $(seq 1 40); do
    if curl -sf "http://127.0.0.1:${API_PORT}/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.25
  done
  echo "api failed to start; log at $LOG" >&2
  exit 1
}

stop_api() {
  [ -n "$SERVER_PID" ] || return 0
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
}

trap stop_api EXIT

require_free_port

# Alembic owns the schema from M1 on, and the API no longer creates tables at boot.
# Idempotent, so running the gate twice is fine.
echo "== applying migrations"
(cd "$API_DIR" && .venv/bin/alembic upgrade head >/dev/null)

echo "== starting api on :${API_PORT}"
start_api

echo
echo "== phase: convergence"
node scripts/m0-gate.mjs seed

echo
echo "== restarting api (cold process, nothing retained in memory)"
stop_api
start_api

echo
echo "== phase: persistence across restart"
node scripts/m0-gate.mjs verify

echo
echo "== phase: offline edit and reconnect"
node scripts/m0-gate.mjs offline

echo
echo "== phase: handshake rejection"
node scripts/m0-gate.mjs reject

echo
echo "== all phases complete"
