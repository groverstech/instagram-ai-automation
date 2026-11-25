#!/usr/bin/env bash
# Staging rehearsal: the production build in strict staging mode (DEPLOY_ENV=staging), as an
# ordinary database role under row-level security (RLS_PILOT=on), with no email provider, social
# sandbox or AI provider: what a fresh staging looks like before its accounts are connected.
#
# It sets up the app role the way DEPLOYMENT §4 describes (migrate as the owner, then
# deploy/app-role-grants.sql), starts the web role, and runs e2e/staging-rehearsal.cjs:
# readiness, invite-only sign-up, required two-step verification, onboarding under RLS, the
# operator emergency-stop drill and the Meta reviewer account.
#
#   E2E_ADMIN_URL  a Postgres URL whose role may create databases and roles (default: TEST_DATABASE_URL)
#   PORT           default 3200
#
# Against a real staging: run e2e/staging-rehearsal.cjs with STAGING_BASE_URL and the operator's
# DATABASE_URL instead (see the script's header). Nothing here calls an external service.
set -euo pipefail
cd "$(dirname "$0")/.."
ADMIN_URL="${E2E_ADMIN_URL:-${TEST_DATABASE_URL:?set E2E_ADMIN_URL or TEST_DATABASE_URL}}"
PORT="${PORT:-3200}"
DB="bp_stage_$(date +%s)"
ROLE="bp_app_$(date +%s)"
PW="$(head -c 18 /dev/urandom | od -An -tx1 | tr -d ' \n')"
if curl -s -o /dev/null --max-time 2 "http://localhost:$PORT/"; then echo "Port $PORT is already in use; stop that server first." >&2; exit 1; fi
psql "$ADMIN_URL" -qc "create database $DB" -c "create role $ROLE login password '$PW' nosuperuser nobypassrls nocreatedb nocreaterole"
OWNER_URL="${ADMIN_URL%/*}/$DB"
HOSTPART="${ADMIN_URL#*@}"; HOSTPART="${HOSTPART%%/*}"
APP_URL_DB="postgres://$ROLE:$PW@$HOSTPART/$DB"
STORE="$(mktemp -d)"
STAGING_ENV=(
  DEPLOY_ENV=staging
  APP_SECRET="$(head -c 48 /dev/urandom | base64)"
  APP_URL="https://staging.example.com"
  AI_PROVIDER=mock AI_ALLOW_MOCK_IN_PRODUCTION=true IMAGE_PROVIDER=none
  STORAGE_DIR="$STORE/files" ALLOW_LOCAL_STORAGE_IN_PRODUCTION=true
  TRUSTED_PROXY_HOPS=1 RUN_JOBS_IN_PROCESS=false RLS_PILOT=on
  AI_SPEND_CAP_REQUIRED=true AI_SPEND_CAP_USD=1 AI_SPEND_CAP_SINCE=2026-01-01T00:00:00Z
  CRON_SECRET="stage-$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
)
cleanup() {
  [ -n "${SERVER:-}" ] && { kill -- "-$SERVER" 2>/dev/null || kill "$SERVER" 2>/dev/null || true; }
  psql "$ADMIN_URL" -qc "drop database if exists $DB with (force)" -c "drop role if exists $ROLE" >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "· migrate as the owner (strict staging checks)"
env "${STAGING_ENV[@]}" DATABASE_URL="$OWNER_URL" npm run -s db:migrate | tail -1
echo "· grant the app role (deploy/app-role-grants.sql)"
psql "$OWNER_URL" -q -v app_role="$ROLE" -f deploy/app-role-grants.sql
echo "· start the web role as $ROLE (ordinary role, RLS pilot on)"
env "${STAGING_ENV[@]}" DATABASE_URL="$APP_URL_DB" PORT="$PORT" setsid npx next start -p "$PORT" > "$STORE/server.log" 2>&1 &
SERVER=$!
for _ in $(seq 60); do curl -sf -o /dev/null "http://localhost:$PORT/api/health/live" && break; sleep 1; done
STAGING_BASE_URL="http://localhost:$PORT" CHECK_DATABASE_URL="$OWNER_URL" SERVER_DATABASE_URL="$APP_URL_DB" APP_ROLE="$ROLE" STAGING_ENV_LINE="${STAGING_ENV[*]}" \
  node e2e/staging-rehearsal.cjs || { echo "--- server log"; tail -60 "$STORE/server.log"; exit 1; }
errs="$(grep '"level":"error"' "$STORE/server.log" | grep -v '"event":"publishing.emergency_stop"' || true)"
if [ -n "$errs" ]; then echo "--- server errors"; echo "$errs" | head -20; exit 1; fi
echo "✓ no server errors"
