#!/usr/bin/env bash
# Full lifecycle journey (launch-readiness Q1) against a production build, with the social sandbox
# and demo AI. Creates a fresh database, starts the server, runs e2e/lifecycle.cjs, stops the server.
#   E2E_ADMIN_URL  a Postgres URL whose role may create databases (default: TEST_DATABASE_URL)
#   PORT           default 3100
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN_URL="${E2E_ADMIN_URL:-${TEST_DATABASE_URL:?set E2E_ADMIN_URL or TEST_DATABASE_URL}}"
PORT="${PORT:-3100}"
DB="bp_e2e_$(date +%s)"
psql "$ADMIN_URL" -qc "create database $DB"
export E2E_DATABASE_URL="${ADMIN_URL%/*}/$DB"
export CRON_SECRET="e2e-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
STORE="$(mktemp -d)"
DATABASE_URL="$E2E_DATABASE_URL" MIGRATE_ON_START=true SOCIAL_SANDBOX=true RUN_JOBS_IN_PROCESS=false \
  STORAGE_DIR="$STORE" AI_PROVIDER=mock AI_ALLOW_MOCK_IN_PRODUCTION=true IMAGE_PROVIDER=none \
  APP_SECRET="$(head -c 48 /dev/urandom | base64)" APP_URL="http://localhost:$PORT" PORT="$PORT" \
  npx next start -p "$PORT" > "$STORE/server.log" 2>&1 &
SERVER=$!
cleanup() { kill "$SERVER" 2>/dev/null || true; psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" >/dev/null 2>&1 || true; }
trap cleanup EXIT
for _ in $(seq 60); do curl -sf -o /dev/null "http://localhost:$PORT/login" && break; sleep 1; done
curl -s -o /dev/null "http://localhost:$PORT/api/health/ready"
E2E_BASE_URL="http://localhost:$PORT" node e2e/lifecycle.cjs "${E2E_SHOTS_DIR:-}" || { echo "--- server log"; tail -50 "$STORE/server.log"; exit 1; }
