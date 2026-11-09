#!/bin/sh
# Container entrypoint: `exec` the real process so it becomes PID 1 and receives SIGTERM directly
# from the orchestrator. Behind `npm run`, signals don't reach the app, so the worker couldn't
# drain and Next couldn't shut down gracefully. TypeScript roles run as `node --import tsx` (one
# process): the tsx CLI runs scripts in a child process and SIGTERM killed it before it could drain.
set -e
role="${1:-web}"
case "$role" in
  web) shift 2>/dev/null || true; exec node_modules/.bin/next start "$@" ;;
  worker) exec node --conditions=react-server --import tsx src/server/jobs/worker.ts ;;
  migrate) exec node --conditions=react-server --import tsx src/server/db/migrate-cli.ts ;;
  *) exec "$@" ;;
esac
